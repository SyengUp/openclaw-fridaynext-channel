import type { DurableRunSourceKind } from "./durable-run-store.js";

const MAX_PENDING = 256;
const pending = new Map<string, DurableRunSourceKind>();

/** `before_agent_run` 的 trigger 是结构化事实；只以精确 runId 传递，不做时间相关。 */
export function noteStructuredRunSource(
  runId: unknown,
  trigger: unknown,
): DurableRunSourceKind | undefined {
  const id = typeof runId === "string" ? runId.trim() : "";
  const value = typeof trigger === "string" ? trigger.trim().toLowerCase() : "";
  if (!id || !value) return undefined;
  const sourceKind: DurableRunSourceKind | undefined =
    value === "user"
      ? "session"
      : value === "heartbeat" || value === "cron" || value === "subagent"
        ? value
        : undefined;
  // 新增/未知 host trigger 不能默认当成人类会话；等升级契约后再显式纳入。
  if (!sourceKind) return undefined;
  pending.delete(id);
  pending.set(id, sourceKind);
  while (pending.size > MAX_PENDING) {
    const oldest = pending.keys().next().value;
    if (!oldest) break;
    pending.delete(oldest);
  }
  return sourceKind;
}

export function structuredRunSource(runId: string): DurableRunSourceKind | undefined {
  return pending.get(runId.trim());
}

export function clearStructuredRunSource(runId: string): void {
  pending.delete(runId.trim());
}

export function resetStructuredRunSourcesForTest(): void {
  pending.clear();
}
