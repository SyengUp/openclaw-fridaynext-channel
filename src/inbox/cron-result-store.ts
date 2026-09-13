import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveFridayNextConfig } from "../config.js";
import { getHostOpenClawConfigSnapshot } from "../host-config.js";
import { getFridayNextRuntime } from "../runtime.js";

export interface CronResultRecord {
  /** 设备内单调递增游标；兼容旧通知接口的 seq。 */
  cursor: number;
  /** 由 cron hook 的稳定事实组成，不依赖正文或时间窗口。 */
  id: string;
  category: "cronResults";
  kind: "cronResult";
  lifecycle: "event";
  occurredAtMs: number;
  deviceId: string;
  jobId: string;
  jobName?: string;
  agentId: string;
  runId?: string;
  sessionId?: string;
  runAtMs?: number;
  durationMs?: number;
  status: string;
  completionStatus?: string;
  summary?: string;
  error?: string;
  delivered?: boolean;
  deliveryStatus?: string;
  deliveryError?: string;
  deliverySuppressionReason?: string;
  deleted?: boolean;
}

export interface CronResultAppendInput extends Omit<CronResultRecord, "cursor" | "id" | "deleted"> {
  sourceIdentity: string;
}

const DEFAULT_KEEP = 200;
let testRoot: string | null = null;

export function setInboxV2RootForTest(root: string | null): void {
  testRoot = root;
}

export function resolveInboxV2Root(): string {
  if (testRoot) return testRoot;
  try {
    const cfg = resolveFridayNextConfig(
      getHostOpenClawConfigSnapshot(getFridayNextRuntime().config),
    );
    return path.join(path.dirname(cfg.historyDir), "inbox-v2");
  } catch {
    return path.join(os.homedir(), ".openclaw", "friday-next", "inbox-v2");
  }
}

function normalizedDeviceId(deviceId: string): string {
  return deviceId.trim().toUpperCase();
}

function stableId(input: Pick<CronResultAppendInput, "jobId" | "sourceIdentity">): string {
  return `cron:${crypto
    .createHash("sha256")
    .update(`${input.jobId}\n${input.sourceIdentity}`)
    .digest("hex")}`;
}

function atomicWrite(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const fd = fs.openSync(temporary, "w", 0o600);
  try {
    fs.writeFileSync(fd, content, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temporary, file);
}

export class CronResultStore {
  private nextCursorByDevice = new Map<string, number>();

  constructor(private readonly overrideRoot: string | null = null) {}

  private root(): string {
    return this.overrideRoot ?? resolveInboxV2Root();
  }

  private resultsDir(): string {
    return path.join(this.root(), "cron-results");
  }

  private devicePath(deviceId: string): string {
    return path.join(this.resultsDir(), `${normalizedDeviceId(deviceId)}.jsonl`);
  }

  private cursorsPath(): string {
    return path.join(this.resultsDir(), "_cursors.json");
  }

  private seenPath(deviceId: string): string {
    return path.join(this.resultsDir(), "_seen", `${normalizedDeviceId(deviceId)}.jsonl`);
  }

  private readSeenIds(deviceId: string): Set<string> {
    const ids = new Set<string>();
    const file = this.seenPath(deviceId);
    if (!fs.existsSync(file)) return ids;
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const id = line.trim();
      if (id) ids.add(id);
    }
    return ids;
  }

  private persistSeenId(deviceId: string, id: string): void {
    const file = this.seenPath(deviceId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const fd = fs.openSync(file, "a", 0o600);
    try {
      fs.writeFileSync(fd, `${id}\n`, "utf8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }

  private durableCursor(deviceId: string): number {
    try {
      const cursors = JSON.parse(fs.readFileSync(this.cursorsPath(), "utf8")) as Record<
        string,
        unknown
      >;
      const value = cursors[normalizedDeviceId(deviceId)];
      return typeof value === "number" && Number.isSafeInteger(value) ? value : 0;
    } catch {
      return 0;
    }
  }

  private persistCursor(deviceId: string, cursor: number): void {
    let cursors: Record<string, unknown> = {};
    try {
      cursors = JSON.parse(fs.readFileSync(this.cursorsPath(), "utf8")) as Record<string, unknown>;
    } catch {
      /* 首次写入。 */
    }
    cursors[normalizedDeviceId(deviceId)] = cursor;
    atomicWrite(this.cursorsPath(), JSON.stringify(cursors));
  }

  private readAll(deviceId: string): CronResultRecord[] {
    const file = this.devicePath(deviceId);
    if (!fs.existsSync(file)) return [];
    const records: CronResultRecord[] = [];
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const value = JSON.parse(line) as CronResultRecord;
        if (typeof value.cursor === "number" && typeof value.id === "string") records.push(value);
      } catch {
        /* 损坏的单行不能清空其余可信历史。 */
      }
    }
    return records;
  }

  private nextCursor(deviceId: string, records: readonly CronResultRecord[]): number {
    const device = normalizedDeviceId(deviceId);
    const diskMax = records.reduce((max, item) => Math.max(max, item.cursor), 0);
    const next = Math.max(this.nextCursorByDevice.get(device) ?? 0, diskMax) + 1;
    const durableMax = this.durableCursor(device);
    const monotonicNext = Math.max(next, durableMax + 1);
    this.nextCursorByDevice.set(device, monotonicNext);
    this.persistCursor(device, monotonicNext);
    return monotonicNext;
  }

  append(input: CronResultAppendInput, keep = DEFAULT_KEEP): CronResultRecord | null {
    const deviceId = normalizedDeviceId(input.deviceId);
    if (!deviceId || !input.jobId.trim() || !input.sourceIdentity.trim()) return null;
    const records = this.readAll(deviceId);
    const id = stableId(input);
    // 事件正文会按保留上限截断，因此另存不可截断的身份账本。包括 tombstone：用户删除或
    // 很久以前的 finished 事件在 gateway 重放后都不能复活。
    if (records.some((item) => item.id === id) || this.readSeenIds(deviceId).has(id)) return null;
    const { sourceIdentity: _sourceIdentity, ...fields } = input;
    const record: CronResultRecord = {
      ...fields,
      cursor: this.nextCursor(deviceId, records),
      id,
      deviceId,
      jobId: input.jobId.trim(),
      agentId: input.agentId.trim().toLowerCase() || "main",
    };
    const retained = [...records, record].slice(-Math.max(1, keep));
    atomicWrite(
      this.devicePath(deviceId),
      retained.map((item) => `${JSON.stringify(item)}\n`).join(""),
    );
    this.persistSeenId(deviceId, id);
    return record;
  }

  readAfter(deviceId: string, afterCursor: number): CronResultRecord[] {
    return this.readAll(deviceId)
      .filter((item) => item.cursor > afterCursor && item.deleted !== true)
      .sort((left, right) => left.cursor - right.cursor);
  }

  currentCursor(deviceId: string): number {
    return Math.max(
      this.durableCursor(deviceId),
      this.readAll(deviceId).reduce((max, item) => Math.max(max, item.cursor), 0),
    );
  }

  delete(deviceId: string, cursor: number): boolean {
    const records = this.readAll(deviceId);
    let removed = false;
    const next = records.map((item) => {
      if (item.cursor !== cursor || item.deleted === true) return item;
      removed = true;
      return {
        cursor: item.cursor,
        id: item.id,
        category: "cronResults",
        kind: "cronResult",
        lifecycle: "event",
        occurredAtMs: item.occurredAtMs,
        deviceId: item.deviceId,
        jobId: item.jobId,
        agentId: item.agentId,
        status: item.status,
        deleted: true,
      } satisfies CronResultRecord;
    });
    if (!removed) return false;
    atomicWrite(
      this.devicePath(deviceId),
      next.map((item) => `${JSON.stringify(item)}\n`).join(""),
    );
    return true;
  }

  resetForTest(): void {
    this.nextCursorByDevice.clear();
  }
}

/**
 * v2 首次启用时清理旧的启发式 cron/push 日志。迁移标记放在新目录；之后即使旧目录
 * 因回滚版本短暂写入，也不会被 v2 当成可信来源重新导入。
 */
export function clearLegacyNotificationLogOnce(): void {
  if (testRoot) return;
  const root = resolveInboxV2Root();
  const marker = path.join(root, ".legacy-notifications-cleared");
  if (fs.existsSync(marker)) return;
  const legacyDir = path.join(path.dirname(root), "notifications");
  try {
    if (fs.existsSync(legacyDir)) {
      for (const name of fs.readdirSync(legacyDir)) {
        if (name === "_seq-counters.json" || name.endsWith(".jsonl")) {
          fs.unlinkSync(path.join(legacyDir, name));
        }
      }
    }
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(marker, JSON.stringify({ schemaVersion: 2, clearedAtMs: Date.now() }), "utf8");
  } catch {
    // 迁移失败不得阻断 cron hook；新接口仍然只读 v2，因此旧数据不会泄漏进收件箱。
  }
}

export const cronResultStore = new CronResultStore();
