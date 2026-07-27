"use strict";
/**
 * ENFORCE_GRANTS expiry-sweep decision (pure).
 *
 * Background: revocation/expiry only bites at a proxy's next NewProxy registration, and frps has
 * no per-proxy close API — the only way to cut an already-established tunnel is to restart frps,
 * which makes EVERY frpc on the relay (including the operator's personal tunnels) re-register.
 * So the sweep must be stingy: restart only when a restart can actually accomplish something.
 *
 * The bug this encodes against: `gateAllowedSubs` remembers every subdomain the gate has allowed
 * since boot, and entries are removed when a re-registration is rejected. A gateway whose frpc is
 * OFFLINE never re-registers, so it was never removed — and the sweep restarted frps for it on
 * every cadence tick, forever (observed in production: hourly relay-wide restarts for two subs
 * that had been gone for days).
 *
 * Rule: each subdomain gets AT MOST ONE forced re-registration per registration episode. If it
 * was kicked and never came back, its client isn't connected; forget it. A live client comes back
 * within seconds of the restart and is rejected there, which removes it on its own.
 *
 * @param entries iterable of [subdomain, { allowedAt, forcedAt }] — millisecond timestamps.
 * @param isActive (sub) => boolean — still entitled (live grant or entitled owner).
 * @returns { forget, kick, restart } — `forget` leaves the map, `kick` gets `forcedAt` stamped,
 *          `restart` says whether to force re-registration now. In cooldown, `forget` still
 *          applies but nothing is stamped, so an un-kicked subdomain stays eligible.
 */
function planExpirySweep({ entries, isActive, now, lastRestartAt, cooldownMs }) {
  const forget = [];
  const stale = [];
  for (const [sub, seen] of entries) {
    if (isActive(sub)) continue;
    if (Number(seen?.forcedAt || 0) > Number(seen?.allowedAt || 0)) {
      forget.push(sub);
      continue;
    }
    stale.push(sub);
  }
  const restart = stale.length > 0 && now - lastRestartAt >= cooldownMs;
  return { forget, kick: restart ? stale : [], restart };
}

module.exports = { planExpirySweep };
