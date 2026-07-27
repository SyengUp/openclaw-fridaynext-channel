#!/usr/bin/env node
// Unit tests for the ENFORCE_GRANTS expiry-sweep decision. This logic caused hourly relay-wide
// frps restarts in production (see expiry-sweep.js), so it gets real coverage rather than
// live observation only.
import sweep from "./expiry-sweep.js";

const { planExpirySweep } = sweep;
let passed = 0;
let failed = 0;

function check(name, ok, detail) {
  if (ok) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const HOUR = 3600_000;
const NOW = 1_000 * HOUR;
const COOLDOWN = HOUR;
const noneActive = () => false;

function plan(entries, options = {}) {
  return planExpirySweep({
    entries: new Map(entries),
    isActive: options.isActive || noneActive,
    now: options.now ?? NOW,
    lastRestartAt: options.lastRestartAt ?? 0,
    cooldownMs: options.cooldownMs ?? COOLDOWN,
  });
}

console.log("— expiry sweep 决策 —");

{
  // A tunnel that registered while entitled and has since lapsed: kick it once.
  const r = plan([["fnstale", { allowedAt: NOW - 2 * HOUR, forcedAt: 0 }]]);
  check("失效隧道首次被踢", r.restart && r.kick.length === 1 && r.kick[0] === "fnstale");
  check("首次不遗忘", r.forget.length === 0);
}

{
  // Already kicked after its last registration and never came back → its frpc is offline.
  const r = plan([["fngone", { allowedAt: NOW - 5 * HOUR, forcedAt: NOW - 4 * HOUR }]]);
  check(
    "踢过一次仍未回来 → 遗忘,不再重启全网",
    r.restart === false && r.kick.length === 0 && r.forget[0] === "fngone",
  );
}

{
  // The production bug: one offline sub must not keep the sweep restarting frps forever.
  let entries = new Map([["fngone", { allowedAt: NOW - 5 * HOUR, forcedAt: NOW - 4 * HOUR }]]);
  let restarts = 0;
  for (let tick = 0; tick < 24; tick++) {
    const r = planExpirySweep({
      entries,
      isActive: noneActive,
      now: NOW + tick * HOUR,
      lastRestartAt: 0,
      cooldownMs: COOLDOWN,
    });
    for (const sub of r.forget) entries.delete(sub);
    if (r.restart) restarts++;
  }
  check("离线隧道 24 轮扫描内产生 0 次重启(旧行为=24 次)", restarts === 0, `restarts=${restarts}`);
}

{
  // Still entitled → the sweep must not touch it at all.
  const r = plan([["fnpaid", { allowedAt: NOW - HOUR, forcedAt: 0 }]], {
    isActive: (sub) => sub === "fnpaid",
  });
  check("仍有权益的隧道不被碰", r.restart === false && r.kick.length === 0 && r.forget.length === 0);
}

{
  // In cooldown: nothing may be stamped (an un-kicked sub must stay eligible), but forgetting an
  // offline entry is independent of the restart budget.
  const r = plan(
    [
      ["fnstale", { allowedAt: NOW - 2 * HOUR, forcedAt: 0 }],
      ["fngone", { allowedAt: NOW - 5 * HOUR, forcedAt: NOW - 4 * HOUR }],
    ],
    { lastRestartAt: NOW - 60_000 },
  );
  check("冷却期内不重启且不打标", r.restart === false && r.kick.length === 0);
  check("冷却期内仍遗忘离线条目", r.forget.length === 1 && r.forget[0] === "fngone");
}

{
  // A returning gateway re-registers (allowedAt bumped past forcedAt) → eligible again.
  const r = plan([["fnback", { allowedAt: NOW - 60_000, forcedAt: NOW - 3 * HOUR }]]);
  check("重新注册过的隧道恢复可踢", r.restart && r.kick[0] === "fnback" && r.forget.length === 0);
}

{
  // Mixed set: one kickable, one offline, one paid — one restart, naming only the kickable one.
  const r = plan(
    [
      ["fnstale", { allowedAt: NOW - 2 * HOUR, forcedAt: 0 }],
      ["fngone", { allowedAt: NOW - 5 * HOUR, forcedAt: NOW - 4 * HOUR }],
      ["fnpaid", { allowedAt: NOW - HOUR, forcedAt: 0 }],
    ],
    { isActive: (sub) => sub === "fnpaid" },
  );
  check("混合集合只为真正需要的一条重启", r.restart && r.kick.length === 1 && r.kick[0] === "fnstale");
  check("混合集合同时遗忘离线条目", r.forget.length === 1 && r.forget[0] === "fngone");
}

{
  const r = plan([]);
  check("空集合不重启", r.restart === false && r.kick.length === 0 && r.forget.length === 0);
}

console.log(`\n${failed ? "❌" : "✅"} passed=${passed} failed=${failed}`);
if (failed) process.exit(1);
