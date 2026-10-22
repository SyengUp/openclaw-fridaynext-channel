import type { DurableRunRecord, RunInspection } from "@syengup/fridaynext-channel-kit";
import { toSessionStoreKey } from "../../session/session-manager.js";
export type RuntimeRecoveryDeps = {
  isRunActive: (run: DurableRunRecord) => Promise<boolean>;
  transcriptProvesCompletion: (run: DurableRunRecord) => boolean;
};

export async function defaultIsRunActive(run: DurableRunRecord): Promise<boolean> {
  if (process.env.VITEST === "true") return false;
  try {
    const harness = await import("openclaw/plugin-sdk/agent-harness");
    for (const key of new Set([run.sessionKey, toSessionStoreKey(run.sessionKey)])) {
      if (harness.resolveActiveEmbeddedRunSessionId(key)) return true;
    }
  } catch {
    // A host without the optional active-run introspection cannot prove the run is alive.
  }
  return false;
}

// 历史只证明消息已写入；没有运行终态的权威事实时保持未知，不能据此释放队列。
export function defaultTranscriptProvesCompletion(_run: DurableRunRecord): boolean {
  return false;
}

export async function inspectOpenClawRun(
  run: DurableRunRecord,
  overrides: Partial<RuntimeRecoveryDeps> = {},
): Promise<RunInspection> {
  if (await (overrides.isRunActive ?? defaultIsRunActive)(run)) return { state: "running" };
  if ((overrides.transcriptProvesCompletion ?? defaultTranscriptProvesCompletion)(run))
    return { state: "completed" };
  return { state: "unknown" };
}
