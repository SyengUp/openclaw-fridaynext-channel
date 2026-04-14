/**
 * Per-run dedupe of outbound media by **canonical source path** (or string key).
 * OpenClaw may call `sendMedia` and later the `message` tool hook may resolve the same
 * file to a different `/friday/files/...` URL — history must only record once.
 */

import { normalizeAgentMediaPath } from "./http/handlers/files.js";

const mediaSourceKeysByRun = new Map<string, Set<string>>();

function canonicalMediaSourceKey(raw: string): string {
  return normalizeAgentMediaPath(raw.trim());
}

/** True if this run has already recorded or claimed this source (e.g. after `tts` tool flush). */
export function hasOutboundMediaSource(runId: string | undefined, raw: string): boolean {
  if (!runId) return false;
  const key = canonicalMediaSourceKey(raw);
  if (!key) return false;
  return mediaSourceKeysByRun.get(runId)?.has(key) ?? false;
}

/**
 * First writer wins: returns true if this canonical source was newly claimed for the run,
 * false if another path (`sendMedia`, tool flush, etc.) already claimed it.
 */
export function tryClaimOutboundMediaSource(runId: string | undefined, raw: string): boolean {
  if (!runId) return true;
  const key = canonicalMediaSourceKey(raw);
  if (!key) return true;
  const set = mediaSourceKeysByRun.get(runId) ?? new Set<string>();
  if (set.has(key)) return false;
  set.add(key);
  mediaSourceKeysByRun.set(runId, set);
  if (mediaSourceKeysByRun.size > 2000) mediaSourceKeysByRun.clear();
  return true;
}

export function clearOutboundMediaSourceDedupe(runId: string): void {
  mediaSourceKeysByRun.delete(runId);
}
