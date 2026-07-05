import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveFridayNextConfig } from "../config.js";
import { getHostOpenClawConfigSnapshot } from "../host-config.js";
import { getFridayNextRuntime } from "../runtime.js";

/**
 * Durable, per-device log of agent-INITIATED background pushes (cron / heartbeat /
 * scheduled tasks). Unlike the SSE offline queue, this is appended *unconditionally*
 * at the outbound boundary — BEFORE the `if (connection)` gate — so a push sent
 * while the Friday device is offline is still captured and surfaced as a
 * notification when the app next reconnects. (Those pushes deliver to ephemeral
 * `agent:<id>:cron:<id>:run:<runId>` / `:heartbeat` sessions the app never shows,
 * which is exactly why the user "感知不到" them.)
 */
export interface FridayNotification {
  /** Per-device monotonic sequence — the unread watermark key. */
  seq: number;
  /** Epoch ms. */
  ts: number;
  agentId: string;
  /** "cron" | "heartbeat" — the background-push kind. */
  kind: string;
  /** Originating (internal) session key, for traceability. */
  sourceSessionKey: string;
  /** The originating scheduled-task's jobId, captured for real announce deliveries whose
   *  session key omits it (see cron-notification-tracker). The endpoint resolves the job's
   *  CURRENT name from this LIVE at read time, so renaming a cron updates past records. */
  jobId?: string;
  /** Last-known job name at capture — a fallback for when the job is later deleted (live
   *  resolution by jobId returns nothing). Live resolution wins while the job exists. */
  jobName?: string;
  text: string;
  hasMedia: boolean;
  /** Soft-delete tombstone marker. A deleted entry is rewritten as a content-less
   *  `{seq, ts, deleted:true}` line: its content is gone (permanent removal), but the seq
   *  survives so `scanMaxSeq` still reflects the true high-water and a later append can NEVER
   *  reuse it — even if the durable seq-counter file is lost/corrupted. `readAfter` skips these. */
  deleted?: boolean;
}

/** Test-only override for the notifications base directory. */
let testBaseDir: string | null = null;
export function setNotificationsBaseDirForTest(dir: string | null): void {
  testBaseDir = dir;
}

export function resolveFridayNextNotificationsDir(): string {
  if (testBaseDir) return testBaseDir;
  try {
    const cfg = resolveFridayNextConfig(
      getHostOpenClawConfigSnapshot(getFridayNextRuntime().config),
    );
    return path.join(path.dirname(cfg.historyDir), "notifications");
  } catch {
    return path.join(os.homedir(), ".openclaw", "friday-next", "notifications");
  }
}

const DEFAULT_KEEP = 200;

/** Classify an outbound delivery's session key into a notification kind, or null
 *  if it is a normal user-facing reply (which is NOT a background notification). */
export function classifyNotificationKind(sessionKey: string | undefined): string | null {
  const k = (sessionKey ?? "").toLowerCase();
  if (!k) return null;
  if (k.includes(":cron:")) return "cron";
  if (k.endsWith(":heartbeat") || k.includes(":heartbeat")) return "heartbeat";
  return null;
}

/** Agent id from a canonical `agent:<id>:...` key (else "main"). */
function agentIdFromKey(sessionKey: string): string {
  const m = sessionKey.match(/^agent:([^:]+):/i);
  return m?.[1]?.toLowerCase() ?? "main";
}

export class FridayNotificationsStore {
  private nextSeqByDevice = new Map<string, number>();

  constructor(private readonly overrideBaseDir: string | null = null) {}

  private baseDir(): string {
    return this.overrideBaseDir ?? resolveFridayNextNotificationsDir();
  }

  private devicePath(deviceId: string): string {
    return path.join(this.baseDir(), `${deviceId.trim().toUpperCase()}.jsonl`);
  }

  private scanMaxSeq(deviceId: string): number {
    const file = this.devicePath(deviceId);
    if (!fs.existsSync(file)) return 0;
    let max = 0;
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const o = JSON.parse(line) as { seq?: number };
        if (typeof o.seq === "number" && o.seq > max) max = o.seq;
      } catch {
        /* skip */
      }
    }
    return max;
  }

  /** Durable high-water seq map (deviceId → highest ever allocated). Kept SEPARATE from the
   *  device log so deleting entries can NEVER lower the next seq — a reused seq would collide
   *  with an app-side tombstone for the old notification and get silently suppressed/re-deleted. */
  private seqCountersPath(): string {
    return path.join(this.baseDir(), "_seq-counters.json");
  }

  private readSeqCounters(): Record<string, number> {
    try {
      const raw = fs.readFileSync(this.seqCountersPath(), "utf8");
      const map = JSON.parse(raw) as Record<string, number>;
      return map && typeof map === "object" ? map : {};
    } catch {
      return {};
    }
  }

  private nextSeq(deviceId: string): number {
    const key = deviceId.trim().toUpperCase();
    // Monotonic across restarts AND deletions: take the max of the in-memory cache, the durable
    // counter, and the live file max (belt-and-suspenders if the counter file is ever lost).
    const counters = this.readSeqCounters();
    const cur = Math.max(
      this.nextSeqByDevice.get(key) ?? 0,
      typeof counters[key] === "number" ? counters[key] : 0,
      this.scanMaxSeq(key),
    );
    const next = cur + 1;
    this.nextSeqByDevice.set(key, next);
    counters[key] = next;
    try {
      fs.mkdirSync(this.baseDir(), { recursive: true });
      fs.writeFileSync(this.seqCountersPath(), JSON.stringify(counters), "utf8");
    } catch {
      /* best-effort — the in-memory cache still holds the line within this process */
    }
    return next;
  }

  /** Append a background push. `sourceSessionKey` decides the kind; non-background
   *  (normal reply) keys are ignored (returns null) — unless `fallbackKind` is set.
   *
   *  `fallbackKind` exists because the core's ChannelOutboundContext carries NO origin
   *  identity: a real cron delivery reaches sendText with the recipient/device session
   *  key (never `agent:…:cron:…`), so key classification alone misses it. The caller
   *  passes a fallback (e.g. "push" when the device is offline) to still capture it. */
  append(args: {
    deviceId: string;
    ts: number;
    sourceSessionKey: string | undefined;
    text: string;
    hasMedia: boolean;
    keep?: number;
    fallbackKind?: string | null;
    jobId?: string;
    jobName?: string;
    // Origin agent id for a background push (cron/heartbeat). The delivery `sourceSessionKey`
    // resolves to the app's CURRENT session agent, not the agent that ran the background job, so
    // deriving the agent from it mislabels every non-main agent's push as `main`. When the caller
    // knows the true origin (from the run-start trackers) it passes it here to override.
    originAgentId?: string | null;
  }): FridayNotification | null {
    const kind = classifyNotificationKind(args.sourceSessionKey) ?? args.fallbackKind ?? null;
    if (!kind) return null;
    const deviceId = args.deviceId.trim().toUpperCase();
    if (!deviceId) return null;

    const jobId = args.jobId?.trim();
    const jobName = args.jobName?.trim();
    const originAgentId = args.originAgentId?.trim().toLowerCase();
    const entry: FridayNotification = {
      seq: this.nextSeq(deviceId),
      ts: args.ts,
      agentId: originAgentId || agentIdFromKey(args.sourceSessionKey ?? ""),
      kind,
      sourceSessionKey: args.sourceSessionKey ?? "",
      ...(jobId ? { jobId } : {}),
      ...(jobName ? { jobName } : {}),
      text: args.text,
      hasMedia: args.hasMedia,
    };
    fs.mkdirSync(this.baseDir(), { recursive: true });
    fs.appendFileSync(this.devicePath(deviceId), JSON.stringify(entry) + "\n", "utf8");
    this.truncateKeepLastN(deviceId, args.keep ?? DEFAULT_KEEP);
    return entry;
  }

  /** Read notifications with `seq > afterSeq`, oldest-first. */
  readAfter(deviceId: string, afterSeq: number): FridayNotification[] {
    const file = this.devicePath(deviceId);
    if (!fs.existsSync(file)) return [];
    const out: FridayNotification[] = [];
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const o = JSON.parse(line) as FridayNotification;
        if (
          typeof o.seq === "number" &&
          o.seq > afterSeq &&
          o.deleted !== true &&
          typeof o.text === "string"
        ) {
          out.push(o);
        }
      } catch {
        /* skip */
      }
    }
    out.sort((a, b) => a.seq - b.seq);
    return out;
  }

  /** Permanently remove one notification (by seq) from a device's durable log. The entry's
   *  CONTENT is dropped, but a content-less `{seq, ts, deleted:true}` tombstone is left in its
   *  place so `scanMaxSeq` keeps reflecting the true high-water — a later append can never reuse
   *  the seq even if the durable counter file is lost/corrupted (which would otherwise resurrect
   *  the seq-reuse bug: a reused seq collides with the app's tombstone and gets silently eaten).
   *  Returns true if a live entry was removed. Idempotent (re-deleting a tombstone → false). */
  delete(deviceId: string, seq: number): boolean {
    const file = this.devicePath(deviceId);
    if (!fs.existsSync(file)) return false;
    const kept: FridayNotification[] = [];
    let removed = false;
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const o = JSON.parse(line) as FridayNotification;
        if (typeof o.seq === "number" && o.seq === seq && o.deleted !== true) {
          removed = true;
          kept.push({ seq: o.seq, ts: o.ts, deleted: true } as FridayNotification);
          continue;
        }
        kept.push(o);
      } catch {
        /* skip malformed lines */
      }
    }
    if (!removed) return false;
    fs.writeFileSync(file, kept.map((e) => JSON.stringify(e) + "\n").join(""), "utf8");
    return true;
  }

  private truncateKeepLastN(deviceId: string, keep: number): void {
    if (keep <= 0) return;
    const file = this.devicePath(deviceId);
    if (!fs.existsSync(file)) return;
    const all: FridayNotification[] = [];
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const o = JSON.parse(line) as FridayNotification;
        if (typeof o.seq === "number") all.push(o);
      } catch {
        /* skip */
      }
    }
    if (all.length <= keep) return;
    fs.writeFileSync(
      file,
      all.slice(-keep).map((e) => JSON.stringify(e) + "\n").join(""),
      "utf8",
    );
  }
}

export const fridayNotificationsStore = new FridayNotificationsStore(null);
