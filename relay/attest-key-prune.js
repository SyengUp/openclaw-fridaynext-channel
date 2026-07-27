"use strict";
/**
 * Which attested App Attest keys to forget.
 *
 * `cp.attestKeys` grew without bound: it only ever gained entries. A single device had piled up
 * 77 of them (37 with signCount 0 — minted and never asserted again) because the app shared ONE
 * App Attest key id between the relay control plane and the gateway plugin, so each server kept
 * rejecting the other's key and forcing a fresh attestation. The app now keeps a separate key per
 * server, but the table still needs a ceiling: nothing else stops a buggy or hostile client from
 * minting keys forever.
 *
 * Two independent rules, both deliberately conservative — dropping a LIVE key is not fatal (the
 * client re-attests) but costs a real Apple round trip, so err toward keeping:
 *
 *   1. dead      — signCount 0 (never asserted after attestation) and older than `deadAfterMs`.
 *                  A key in real use has a non-zero signCount within minutes of being minted.
 *   2. overflow  — beyond `max` entries, evict least-recently-active first. Activity is
 *                  `lastUsedAt || createdAt`, so a key asserted today always outranks an old one.
 *
 * Pure function: callers apply the returned ids and do their own logging/persistence.
 */

const DAY_MS = 86_400_000;

/**
 * @param {Record<string, {signCount?: number, createdAt?: number, lastUsedAt?: number}>} keys
 * @param {{ now: number, max?: number, deadAfterMs?: number }} options
 * @returns {{ drop: string[], dead: string[], overflow: string[], kept: number }}
 */
function planAttestKeyPrune(keys, options) {
  const now = Number(options?.now) || 0;
  const max = Number.isFinite(options?.max) ? Number(options.max) : 500;
  const deadAfterMs = Number.isFinite(options?.deadAfterMs) ? Number(options.deadAfterMs) : DAY_MS;

  const entries = Object.entries(keys || {});
  const activity = (v) => Number(v?.lastUsedAt || v?.createdAt || 0);

  const dead = [];
  for (const [id, v] of entries) {
    const created = Number(v?.createdAt || 0);
    // Guard against a missing/absurd createdAt: without a trustworthy age we cannot call it dead.
    if (!created || created > now) continue;
    if (Number(v?.signCount || 0) !== 0) continue;
    if (now - created <= deadAfterMs) continue;
    dead.push(id);
  }

  const deadSet = new Set(dead);
  const survivors = entries.filter(([id]) => !deadSet.has(id));
  const overflow = [];
  if (max >= 0 && survivors.length > max) {
    survivors
      .slice()
      .sort((a, b) => activity(a[1]) - activity(b[1]))
      .slice(0, survivors.length - max)
      .forEach(([id]) => overflow.push(id));
  }

  return {
    drop: [...dead, ...overflow],
    dead,
    overflow,
    kept: entries.length - dead.length - overflow.length,
  };
}

module.exports = { planAttestKeyPrune, DAY_MS };
