/**
 * Which attested App Attest keys to forget.
 *
 * `attested-keys.json` only ever gained entries. A single device had piled up 74 of them because
 * the app shared ONE App Attest key id between this gateway and the relay control plane, so each
 * server kept rejecting the other's key and forcing a fresh attestation. The app now keeps a
 * separate key per server, but the file still needs a ceiling: nothing else stops a buggy or
 * hostile client from minting keys forever.
 *
 * Mirrors `attest-key-prune.js` in the `friday-tunnel-relay` repo — same two rules, both
 * deliberately conservative, because
 * dropping a LIVE key is not fatal (the client re-attests) but costs a real Apple round trip:
 *
 *   1. dead      — signCount 0 (never asserted after attestation) and older than `deadAfterMs`.
 *   2. overflow  — beyond `max` entries, evict least-recently-active (`lastUsedAt || createdAt`).
 *
 * Pure function: callers apply the returned ids and do their own persistence/logging.
 */

export const DAY_MS = 86_400_000;

export type PrunableKey = {
  signCount?: number;
  createdAt?: number;
  lastUsedAt?: number;
};

export type PrunePlan = {
  drop: string[];
  dead: string[];
  overflow: string[];
  kept: number;
};

export function planAttestKeyPrune(
  keys: Record<string, PrunableKey>,
  options: { now: number; max?: number; deadAfterMs?: number },
): PrunePlan {
  const now = Number(options?.now) || 0;
  const max = Number.isFinite(options?.max) ? Number(options.max) : 200;
  const deadAfterMs = Number.isFinite(options?.deadAfterMs) ? Number(options.deadAfterMs) : DAY_MS;

  const entries = Object.entries(keys ?? {});
  const activity = (v: PrunableKey): number => Number(v?.lastUsedAt ?? v?.createdAt ?? 0);

  const dead: string[] = [];
  for (const [id, v] of entries) {
    const created = Number(v?.createdAt ?? 0);
    // Without a trustworthy age we cannot call it dead — keeping it is the safe failure.
    if (!created || created > now) continue;
    if (Number(v?.signCount ?? 0) !== 0) continue;
    if (now - created <= deadAfterMs) continue;
    dead.push(id);
  }

  const deadSet = new Set(dead);
  const survivors = entries.filter(([id]) => !deadSet.has(id));
  const overflow: string[] = [];
  if (max >= 0 && survivors.length > max) {
    for (const [id] of survivors
      .slice()
      .sort((a, b) => activity(a[1]) - activity(b[1]))
      .slice(0, survivors.length - max)) {
      overflow.push(id);
    }
  }

  return {
    drop: [...dead, ...overflow],
    dead,
    overflow,
    kept: entries.length - dead.length - overflow.length,
  };
}
