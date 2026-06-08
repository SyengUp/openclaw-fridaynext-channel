/**
 * Reads the cumulative session-usage snapshot from the OpenClaw session store
 * (`sessions.json`) for a given Friday session key.
 *
 * Shared by two readers:
 *   - the live terminal-lifecycle forward (`friday-session.ts`), which stamps the
 *     snapshot onto the `lifecycle.end` frame, and
 *   - the history endpoint (`http/handlers/history-messages.ts`), which returns it
 *     alongside the transcript so a rebuild can restore the nav-bar context ring.
 *
 * The snapshot is **session-cumulative**, not per-message: `context.windowMax` is
 * the model's context window and `context.used` is the running session total. The
 * transcript only carries per-message `model` + `usage.{total,input,output}`; the
 * context-window figures live only here, in the session store.
 */

import { getFridayAgentForwardRuntime } from "./agent-forward-runtime.js";
import { toSessionStoreKey, agentIdFromSessionKey } from "./session/session-manager.js";
import { buildSessionUsageSnapshot } from "./session-usage-snapshot.js";
import type { FridaySessionUsagePayload } from "./session-usage-snapshot.js";

export function readSessionUsageSnapshotFromStore(
  sessionKeyForStore: string,
): FridaySessionUsagePayload | undefined {
  const access = getFridayAgentForwardRuntime();
  if (!access) return undefined;
  try {
    const cfg = access.getConfig() as { session?: { store?: string } } | null | undefined;
    const storeConfig = cfg?.session?.store;
    const canonical = toSessionStoreKey(sessionKeyForStore);
    const storePath = access.resolveStorePath(storeConfig, { agentId: agentIdFromSessionKey(canonical) });
    const store = access.loadSessionStore(storePath, { skipCache: true }) as Record<
      string,
      Record<string, unknown>
    >;
    const entry = store[canonical] ?? store[sessionKeyForStore.trim()];
    if (!entry || typeof entry !== "object") return undefined;
    return buildSessionUsageSnapshot(entry);
  } catch {
    return undefined;
  }
}
