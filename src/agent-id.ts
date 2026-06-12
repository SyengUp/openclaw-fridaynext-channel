/**
 * Agent id normalization shared across handlers.
 *
 * Mirror of OpenClaw's `normalizeAgentId` (src/routing/session-key.ts): trim,
 * lowercase, keep path/shell-safe. Empty → "main".
 */

export const DEFAULT_AGENT_ID = "main";

/** Agent ids already in path/shell-safe form skip the slug rewrite below. */
const SAFE_AGENT_ID = /^[a-z0-9][a-z0-9_-]*$/;

export function normalizeAgentId(value: unknown): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) return DEFAULT_AGENT_ID;
  const lowered = trimmed.toLowerCase();
  if (SAFE_AGENT_ID.test(lowered)) return lowered;
  return (
    lowered
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || DEFAULT_AGENT_ID
  );
}
