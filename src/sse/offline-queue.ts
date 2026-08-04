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
    const cfg = resolveFridayNextConfig(
      getHostOpenClawConfigSnapshot(getFridayNextRuntime().config),
    );
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

  /**
   * 每设备的当前文件行数（进程内维护；本进程是该文件的唯一写者）。
   * 用来把「整文件重写」摊销掉——此前每 append 一条都要全文件读+逐行 JSON.parse+重写，
   * 流式期每个 delta 都付一次，全是同步 I/O 且跑在网关主事件循环上。
   */
  private readonly lineCounts = new Map<string, number>();

  private baseDir(): string {
    if (this.overrideBaseDir) return this.overrideBaseDir;
    return resolveFridayNextEventsQueueDir();
  }

  private deviceKey(deviceId: string): string {
    return deviceId.trim().toUpperCase();
  }

  private devicePath(deviceId: string): string {
    return path.join(this.baseDir(), `${this.deviceKey(deviceId)}.jsonl`);
  }

  private countLines(file: string): number {
    if (!fs.existsSync(file)) return 0;
    let n = 0;
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      if (line.trim()) n += 1;
    }
    return n;
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

  append(
    deviceId: string,
    id: number,
    event: string,
    data: Record<string, unknown>,
    backlogLimit: number,
  ): void {
    if (event === "connected") return;
    this.ensureDir();
    const file = this.devicePath(deviceId);
    const line = JSON.stringify({ id, event, data } satisfies PersistedSseEntry) + "\n";
    fs.appendFileSync(file, line, "utf8");
    if (backlogLimit <= 0) return;

    // 摊销整文件重写：只有涨出半个上限的余量才重写一次（keep=200 → 每 100 条一次，
    // 而不是每条一次）。文件因此在 [keep, keep + keep/2] 之间浮动——replay 按 id 过滤，
    // 多留一点只是回放窗口略宽，不影响正确性。
    const key = this.deviceKey(deviceId);
    const known = this.lineCounts.get(key);
    let count = known === undefined ? this.countLines(file) : known + 1;
    const slack = Math.max(1, Math.floor(backlogLimit / 2));
    if (count > backlogLimit + slack) {
      this.truncateKeepLastN(deviceId, backlogLimit);
      count = backlogLimit;
    }
    this.lineCounts.set(key, count);
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
        if (
          typeof o.id === "number" &&
          typeof o.event === "string" &&
          o.data &&
          typeof o.data === "object"
        ) {
          all.push(o);
        }
      } catch {
        /* skip */
      }
    }
    if (all.length <= keep) {
      this.lineCounts.set(this.deviceKey(deviceId), all.length);
      return;
    }
    const slice = all.slice(-keep);
    fs.writeFileSync(file, slice.map((e) => JSON.stringify(e) + "\n").join(""), "utf8");
    this.lineCounts.set(this.deviceKey(deviceId), slice.length);
  }
}

/** Shared queue: base directory follows `setOfflineQueueBaseDirForTest` / config. */
export const fridaySseOfflineQueue = new FridaySseOfflineQueue(null);
