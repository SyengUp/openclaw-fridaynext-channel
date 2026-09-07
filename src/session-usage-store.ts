/**
 * Resolves the current prompt/context snapshot for a Friday session key.
 *
 * Shared by live forwarding, history, and runtime-v3 recovery:
 *   - the live terminal-lifecycle forward (`friday-session.ts`), which stamps the
 *     snapshot onto the `lifecycle.end` frame, and
 *   - the history endpoint (`http/handlers/history-messages.ts`), which returns it
 *     alongside the transcript so a rebuild can restore the nav-bar context ring.
 *
 * The primary path calls Gateway `sessions.list`, exactly like Control UI. Its
 * projected row supplies `totalTokens` (current prompt footprint) and
 * `contextTokens` (effective model window). Raw store access remains only as a
 * compatibility fallback for older hosts or an unavailable Gateway runtime.
 *
 * Prefers `getSessionEntry` (SQLite). COMPAT(openclaw<2026.8.1): `loadSessionStore`.
 */

import { buildSessionUsageSnapshot } from "./session-usage-snapshot.js";
import type { FridaySessionUsagePayload } from "./session-usage-snapshot.js";
import { getFridayAgentForwardRuntime } from "./agent-forward-runtime.js";
import { findSessionStoreRow } from "./history/session-store-access.js";
import { agentIdFromSessionKey, toSessionStoreKey } from "./session/session-manager.js";

type GatewaySessionRow = Record<string, unknown> & { key?: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function findProjectedSessionRow(payload: unknown, sessionKey: string): GatewaySessionRow | null {
  if (!isRecord(payload) || !Array.isArray(payload.sessions)) return null;
  const target = sessionKey.toLowerCase();
  for (const value of payload.sessions) {
    if (!isRecord(value) || typeof value.key !== "string") continue;
    if (value.key.toLowerCase() === target) return value;
  }
  return null;
}

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

/**
 * Reads the same projected session row as Control UI. This is intentionally
 * async because the in-process Gateway request performs the canonical model
 * context-window projection before returning `totalTokens/contextTokens`.
 */
export async function readSessionUsageSnapshot(
  sessionKey: string,
): Promise<FridaySessionUsagePayload | undefined> {
  const rt = getFridayAgentForwardRuntime();
  const canonicalKey = toSessionStoreKey(sessionKey);
  if (rt?.gatewayRequest) {
    try {
      const available = rt.gatewayIsAvailable ? await rt.gatewayIsAvailable() : true;
      if (available) {
        const payload = await rt.gatewayRequest(
          "sessions.list",
          {
            agentId: agentIdFromSessionKey(canonicalKey),
            includeGlobal: true,
            includeUnknown: true,
            configuredAgentsOnly: true,
            archived: "all",
            search: canonicalKey,
            limit: 10,
          },
          { timeoutMs: 1_500, scopes: ["operator.read"] },
        );
        if (isRecord(payload) && Array.isArray(payload.sessions)) {
          const row = findProjectedSessionRow(payload, canonicalKey);
          return row ? buildSessionUsageSnapshot(row) : undefined;
        }
      }
    } catch {
      // COMPAT: older gateways may not expose the in-process request surface.
    }
  }
  return readSessionUsageSnapshotFromStore(canonicalKey);
}
