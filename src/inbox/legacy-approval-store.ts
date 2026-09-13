import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveInboxV2Root } from "./cron-result-store.js";

export type LegacyApprovalKind = "exec" | "plugin" | "system-agent";

export interface LegacyApprovalPayload {
  op: "request" | "resolved" | "expired";
  approvalId: string;
  kind: LegacyApprovalKind;
  title: string;
  description?: string | null;
  commandText?: string | null;
  cwd?: string | null;
  host?: string | null;
  toolName?: string | null;
  severity?: string | null;
  proposalHash?: string | null;
  agentId?: string | null;
  sessionKey?: string | null;
  metadata: { label: string; value: string }[];
  actions: { decision: string; label: string; style: string }[];
  createdAtMs?: number | null;
  expiresAtMs?: number | null;
  deviceId: string;
  ts: number;
}

interface StoredApproval {
  kind: LegacyApprovalKind;
  id: string;
  createdAtMs: number;
  expiresAtMs: number;
  request: Record<string, unknown>;
}

interface StoreFile {
  schemaVersion: 1;
  processEpoch: string;
  approvals: StoredApproval[];
}

const PROCESS_EPOCH_KEY = Symbol.for("friday-next.inbox.compat-approval-process-epoch");

function currentProcessEpoch(): string {
  const globalState = globalThis as typeof globalThis & { [PROCESS_EPOCH_KEY]?: string };
  globalState[PROCESS_EPOCH_KEY] ??= crypto.randomUUID();
  return globalState[PROCESS_EPOCH_KEY];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function approvalKey(kind: LegacyApprovalKind, id: string): string {
  return `${kind}\n${id}`;
}

function agentIdFromPayload(payload: LegacyApprovalPayload): string | undefined {
  const explicit = stringValue(payload.agentId);
  if (explicit) return explicit;
  const match = stringValue(payload.sessionKey)?.match(/^agent:([^:]+):/i);
  return match?.[1];
}

function normalizeStoredApproval(value: unknown): StoredApproval | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const item = value as Partial<StoredApproval>;
  if (item.kind !== "exec" && item.kind !== "plugin" && item.kind !== "system-agent") {
    return undefined;
  }
  if (
    typeof item.id !== "string" ||
    item.id.length === 0 ||
    typeof item.createdAtMs !== "number" ||
    !Number.isFinite(item.createdAtMs) ||
    typeof item.expiresAtMs !== "number" ||
    !Number.isFinite(item.expiresAtMs) ||
    !item.request ||
    typeof item.request !== "object" ||
    Array.isArray(item.request)
  ) {
    return undefined;
  }
  return item as StoredApproval;
}

function atomicWrite(file: string, value: StoreFile): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const fd = fs.openSync(temporary, "w", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(value), "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temporary, file);
}

/**
 * OpenClaw 2026.7.1 没有 pending approval list RPC。该存储只镜像 approval capability
 * 收到的结构化生命周期，不从正文或会话状态推断审批。
 */
export class LegacyApprovalStore {
  constructor(
    private readonly overrideRoot: string | null = null,
    private readonly processEpoch = currentProcessEpoch(),
  ) {}

  private file(): string {
    return path.join(this.overrideRoot ?? resolveInboxV2Root(), "compat-approvals.json");
  }

  private read(): StoredApproval[] {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file(), "utf8")) as Partial<StoreFile>;
      // 旧宿主的 gateway process 重启会清空原生 pending manager。磁盘镜像只允许
      // 跨同进程 plugin reload 存活，绝不能把上个进程已经失效的审批重新展示出来。
      if (
        parsed.schemaVersion !== 1 ||
        parsed.processEpoch !== this.processEpoch ||
        !Array.isArray(parsed.approvals)
      ) {
        return [];
      }
      return parsed.approvals.flatMap((item) => {
        const normalized = normalizeStoredApproval(item);
        return normalized ? [normalized] : [];
      });
    } catch {
      return [];
    }
  }

  private write(approvals: StoredApproval[]): void {
    atomicWrite(this.file(), { schemaVersion: 1, processEpoch: this.processEpoch, approvals });
  }

  upsert(payload: LegacyApprovalPayload): boolean {
    if (payload.op !== "request") return this.remove(payload.kind, payload.approvalId);
    const id = payload.approvalId;
    const expiresAtMs = payload.expiresAtMs;
    const createdAtMs =
      typeof payload.createdAtMs === "number" && Number.isFinite(payload.createdAtMs)
        ? payload.createdAtMs
        : payload.ts;
    if (
      !id ||
      typeof expiresAtMs !== "number" ||
      !Number.isFinite(expiresAtMs) ||
      !Number.isFinite(createdAtMs)
    ) {
      return false;
    }
    const agentId = agentIdFromPayload(payload);
    const request: Record<string, unknown> =
      payload.kind === "exec"
        ? {
            ...(stringValue(payload.commandText)
              ? { command: stringValue(payload.commandText) }
              : {}),
            ...(stringValue(payload.cwd) ? { cwd: stringValue(payload.cwd) } : {}),
            ...(stringValue(payload.host) ? { host: stringValue(payload.host) } : {}),
            ...(agentId ? { agentId } : {}),
          }
        : {
            ...(stringValue(payload.title) ? { title: stringValue(payload.title) } : {}),
            ...(stringValue(payload.description)
              ? { description: stringValue(payload.description) }
              : {}),
            ...(stringValue(payload.commandText)
              ? { command: stringValue(payload.commandText) }
              : {}),
            ...(stringValue(payload.proposalHash)
              ? { proposalHash: stringValue(payload.proposalHash) }
              : {}),
            ...(stringValue(payload.toolName) ? { toolName: stringValue(payload.toolName) } : {}),
            ...(stringValue(payload.severity) ? { severity: stringValue(payload.severity) } : {}),
            ...(agentId ? { agentId } : {}),
          };
    const approvals = this.read();
    const key = approvalKey(payload.kind, id);
    const existing = approvals.find((item) => approvalKey(item.kind, item.id) === key);
    const next: StoredApproval = {
      kind: payload.kind,
      id,
      createdAtMs: existing?.createdAtMs ?? createdAtMs,
      expiresAtMs,
      request,
    };
    this.write([...approvals.filter((item) => approvalKey(item.kind, item.id) !== key), next]);
    return true;
  }

  remove(kind: LegacyApprovalKind, id: string): boolean {
    if (!id) return false;
    const approvals = this.read();
    const key = approvalKey(kind, id);
    const next = approvals.filter((item) => approvalKey(item.kind, item.id) !== key);
    if (next.length === approvals.length) return false;
    this.write(next);
    return true;
  }

  list(kind: LegacyApprovalKind, nowMs = Date.now()): unknown[] {
    const approvals = this.read();
    const retained = approvals.filter((item) => item.expiresAtMs > nowMs);
    if (retained.length !== approvals.length) this.write(retained);
    return retained
      .filter((item) => item.kind === kind)
      .map(({ id, createdAtMs, expiresAtMs, request }) => ({
        id,
        createdAtMs,
        expiresAtMs,
        request,
      }));
  }

  resetForTest(): void {
    // 当前实现没有内存缓存；保留统一测试钩子，避免未来加入缓存时测试状态泄漏。
  }
}

// COMPAT(openclaw<=2026.7.1 approval-list-rpc): 仅供明确缺少 pending-list RPC 时回退。
// CLEANUP: 最低宿主版本高于 2026.7.1 后删除本存储、capability 镜像写入和路由回退测试。
export const legacyApprovalStore = new LegacyApprovalStore();
