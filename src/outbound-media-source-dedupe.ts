/**
 * Per-run dedupe of outbound media by **canonical source path** (or string key).
 * OpenClaw may call `sendMedia` and later the `message` tool hook may resolve the same
 * file to a different `/friday/files/...` URL — history must only record once.
 */

import { normalizeAgentMediaPath } from "./http/handlers/files.js";

const mediaSourceKeysByRun = new Map<string, Set<string>>();

/** Stable key for the same Friday-served file across `https://host/.../friday/files/x` vs `/friday/files/x`. */
function fridayMediaKey(raw: string): string | null {
  const s = raw.trim();
  const mAbs = s.match(/^https?:\/\/[^/]+\/friday\/files\/([^/?#]+)/i);
  const mRel = s.match(/^\/friday\/files\/([^/?#]+)/i);
  const enc = mAbs?.[1] ?? mRel?.[1];
  if (!enc) return null;
  try {
    return `friday:${decodeURIComponent(enc)}`;
  } catch {
    return `friday:${enc}`;
  }
}

function canonicalMediaSourceKey(raw: string): string {
  const fk = fridayMediaKey(raw);
  if (fk) return fk;
  const s = raw.trim();
  const mIn = s.match(/^media:\/\/inbound\/([^/?#]+)/i);
  if (mIn?.[1]) return `inbound:${mIn[1]}`;
  return normalizeAgentMediaPath(s);
}

/** True if this run has already recorded or claimed this source (e.g. after `tts` tool flush). */
export function hasOutboundMediaSource(runId: string | undefined, raw: string): boolean {
  if (!runId) return false;
  const key = canonicalMediaSourceKey(raw);
  if (!key) return false;
  return mediaSourceKeysByRun.get(runId)?.has(key) ?? false;
}

/**
 * First writer wins for a **group** of equivalent strings (e.g. local temp path + resolved
 * `/friday/files/...` for the same TTS file). If **any** canonical key is already claimed
 * for the run, returns false and does not mutate; otherwise adds **all** keys.
 */
export function tryClaimOutboundMediaGroup(runId: string | undefined, raws: string[]): boolean {
  if (!runId) return true;
  const keys = [...new Set(raws.map(canonicalMediaSourceKey).filter((k) => k.length > 0))];
  if (keys.length === 0) return true;
  const set = mediaSourceKeysByRun.get(runId) ?? new Set<string>();
  if (keys.some((k) => set.has(k))) return false;
  for (const k of keys) set.add(k);
  mediaSourceKeysByRun.set(runId, set);
  if (mediaSourceKeysByRun.size > 2000) mediaSourceKeysByRun.clear();
  return true;
}

/**
 * First writer wins: returns true if this canonical source was newly claimed for the run,
 * false if another path (`sendMedia`, tool flush, etc.) already claimed it.
 */
export function tryClaimOutboundMediaSource(runId: string | undefined, raw: string): boolean {
  return tryClaimOutboundMediaGroup(runId, [raw]);
}

export function clearOutboundMediaSourceDedupe(runId: string): void {
  mediaSourceKeysByRun.delete(runId);
}
