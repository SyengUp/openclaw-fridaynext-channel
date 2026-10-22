import { ChannelError } from "@syengup/fridaynext-channel-kit";
import { getFridayAgentForwardRuntime } from "../../agent-forward-runtime.js";
import { bindFridayDeviceToSession } from "../../friday-session.js";
import { findSessionStoreRow } from "../../history/session-store-access.js";
import { agentIdFromSessionKey, toSessionStoreKey } from "../../session/session-manager.js";
import { mappedNativeSessionKey } from "./session-metadata.js";

// 这里只处理原生 store 和 SDK 兼容差异；产品 HTTP 与设备订阅持久化属于 Kit。
function writableSession(key: string) {
  const runtime = getFridayAgentForwardRuntime();
  if (!runtime?.patchSessionEntry && !runtime?.updateSessionStoreEntry)
    throw new ChannelError(503, "UNAVAILABLE", "Session store write not available");
  const row = findSessionStoreRow(key);
  if (!row) throw new ChannelError(404, "NOT_FOUND", `Session not found: ${key}`);
  return { runtime, row, agentId: agentIdFromSessionKey(row.sessionKey) };
}

export async function setOpenClawSessionTitle(key: string, title: string) {
  const { runtime, row, agentId } = writableSession(key);
  const update = () => ({ displayName: title || undefined });
  try {
    const updated = runtime.patchSessionEntry
      ? await runtime.patchSessionEntry({
          sessionKey: row.sessionKey,
          agentId,
          preserveActivity: true,
          update,
        })
      : await runtime.updateSessionStoreEntry!({
          storePath: runtime.resolveStorePath(undefined, { agentId }),
          sessionKey: row.sessionKey,
          update,
        });
    const sessionId =
      updated && typeof updated.sessionId === "string" ? updated.sessionId : undefined;
    return { title, ...(sessionId ? { sessionId } : {}) };
  } catch {
    throw new ChannelError(500, "UPDATE_FAILED", "Failed to update session title");
  }
}

const finite = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;
export async function setOpenClawSessionPinned(key: string, pinned: boolean) {
  const { runtime, row, agentId } = writableSession(key);
  const update = (entry: Record<string, unknown>) =>
    pinned
      ? { pinned: true, pinnedAt: finite(entry.pinnedAt) ?? Date.now() }
      : { pinned: false, pinnedAt: undefined };
  let updated: Record<string, unknown> | null = null;
  if (runtime.patchSessionEntry) {
    try {
      updated = await runtime.patchSessionEntry({
        sessionKey: row.sessionKey,
        agentId,
        preserveActivity: true,
        update,
      });
    } catch {
      /* 新写入器不可用时保留旧宿主的 JSON store 兼容路径。 */
    }
  }
  if (!updated && runtime.updateSessionStoreEntry) {
    try {
      updated = await runtime.updateSessionStoreEntry({
        storePath: runtime.resolveStorePath(undefined, { agentId }),
        sessionKey: row.sessionKey,
        update,
      });
    } catch {
      throw new ChannelError(500, "UPDATE_FAILED", "Failed to update session pin");
    }
  }
  const pinnedAt = finite(updated?.pinnedAt);
  if (!updated || (pinned && pinnedAt === undefined) || (!pinned && pinnedAt !== undefined))
    throw new ChannelError(500, "UPDATE_FAILED", "Failed to update session pin");
  return { pinned, ...(pinned && pinnedAt !== undefined ? { pinnedAt } : {}) };
}

export async function bindOpenClawSession(sessionKey: string, deviceId: string) {
  return {
    runtimeSessionKey:
      mappedNativeSessionKey(sessionKey) ??
      (/^agent:/i.test(sessionKey) ? toSessionStoreKey(sessionKey) : undefined),
    replayed: bindFridayDeviceToSession(sessionKey, deviceId),
  };
}
