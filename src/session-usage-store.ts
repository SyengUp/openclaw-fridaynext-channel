/**
 * Reads the cumulative session-usage snapshot from the OpenClaw session store
 * for a given Friday session key.
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
 *
 * Prefers `getSessionEntry` (SQLite). COMPAT(openclaw<2026.8.1): `loadSessionStore`.
 */

import { buildSessionUsageSnapshot } from "./session-usage-snapshot.js";
import type { FridaySessionUsagePayload } from "./session-usage-snapshot.js";
import { findSessionStoreRow } from "./history/session-store-access.js";

export function readSessionUsageSnapshotFromStore(
  sessionKeyForStore: string,
): FridaySessionUsagePayload | undefined {
  try {
    const row = findSessionStoreRow(sessionKeyForStore);
    if (!row) return undefined;
    return buildSessionUsageSnapshot(row.entry);
  } catch {
    return undefined;
  }
}
