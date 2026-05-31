import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveFridayNextConfig } from "../config.js";
import { getHostOpenClawConfigSnapshot } from "../host-config.js";
import { getFridayNextRuntime } from "../runtime.js";

export type PersistedSseEntry = {
  id: number;
  event: string;
  data: Record<string, unknown>;
};

/** Test-only override for queue base directory. */
let testQueueBaseDir: string | null = null;

export function setOfflineQueueBaseDirForTest(dir: string | null): void {
  testQueueBaseDir = dir;
}

export function resolveFridayNextEventsQueueDir(): string {
  if (testQueueBaseDir) return testQueueBaseDir;
  try {
    const cfg = resolveFridayNextConfig(getHostOpenClawConfigSnapshot(getFridayNextRuntime().config));
    return path.join(path.dirname(cfg.historyDir), "events-queue");
  } catch {
    return path.join(os.homedir(), ".openclaw", "friday-next", "events-queue");
  }
}

/**
 * Per-device JSONL persistence for SSE replay.
 * `overrideBaseDir` is for tests; production uses `resolveFridayNextEventsQueueDir()`.
 */
export class FridaySseOfflineQueue {
  constructor(private readonly overrideBaseDir: string | null = null) {}

  private baseDir(): string {
    if (this.overrideBaseDir) return this.overrideBaseDir;
    return resolveFridayNextEventsQueueDir();
  }

  private devicePath(deviceId: string): string {
    const key = deviceId.trim().toUpperCase();
    return path.join(this.baseDir(), `${key}.jsonl`);
  }

  private ensureDir(): void {
    fs.mkdirSync(this.baseDir(), { recursive: true });
  }

  /** Highest id in file (full scan; ok for bounded backlog). */
  scanMaxId(deviceId: string): number {
    const file = this.devicePath(deviceId);
    if (!fs.existsSync(file)) return 0;
    let max = 0;
    const content = fs.readFileSync(file, "utf8");
    for (const line of content.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const o = JSON.parse(line) as { id?: number };
        if (typeof o.id === "number" && o.id > max) max = o.id;
      } catch {
        /* skip corrupt line */
      }
    }
    return max;
  }

  latestId(deviceId: string): number {
    return this.scanMaxId(deviceId.trim().toUpperCase());
  }

  append(deviceId: string, id: number, event: string, data: Record<string, unknown>, backlogLimit: number): void {
    if (event === "connected") return;
    this.ensureDir();
    const file = this.devicePath(deviceId);
    const line = JSON.stringify({ id, event, data } satisfies PersistedSseEntry) + "\n";
    fs.appendFileSync(file, line, "utf8");
    if (backlogLimit > 0) {
      this.truncateKeepLastN(deviceId, backlogLimit);
    }
  }

  readAfter(deviceId: string, afterId: number): PersistedSseEntry[] {
    const file = this.devicePath(deviceId);
    if (!fs.existsSync(file)) return [];
    const out: PersistedSseEntry[] = [];
    const content = fs.readFileSync(file, "utf8");
    for (const line of content.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const o = JSON.parse(line) as PersistedSseEntry;
        if (
          typeof o.id === "number" &&
          o.id > afterId &&
          typeof o.event === "string" &&
          o.data &&
          typeof o.data === "object" &&
          !Array.isArray(o.data)
        ) {
          out.push(o);
        }
      } catch {
        /* skip */
      }
    }
    out.sort((a, b) => a.id - b.id);
    return out;
  }

  truncateKeepLastN(deviceId: string, keep: number): void {
    if (keep <= 0) return;
    const file = this.devicePath(deviceId);
    if (!fs.existsSync(file)) return;
    const all: PersistedSseEntry[] = [];
    const content = fs.readFileSync(file, "utf8");
    for (const line of content.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const o = JSON.parse(line) as PersistedSseEntry;
        if (typeof o.id === "number" && typeof o.event === "string" && o.data && typeof o.data === "object") {
          all.push(o);
        }
      } catch {
        /* skip */
      }
    }
    if (all.length <= keep) return;
    const slice = all.slice(-keep);
    fs.writeFileSync(
      file,
      slice.map((e) => JSON.stringify(e) + "\n").join(""),
      "utf8",
    );
  }
}

/** Shared queue: base directory follows `setOfflineQueueBaseDirForTest` / config. */
export const fridaySseOfflineQueue = new FridaySseOfflineQueue(null);
