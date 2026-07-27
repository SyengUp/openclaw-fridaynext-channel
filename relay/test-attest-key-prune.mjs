#!/usr/bin/env node
// Unit tests for the attested-key prune policy. This table grew without bound in production
// (77 keys from ONE device, 37 never asserted), so its ceiling gets real coverage.
import prune from "./attest-key-prune.js";

const { planAttestKeyPrune } = prune;
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
const DAY = 24 * HOUR;
const NOW = 1_000 * DAY;

console.log("— attest key prune 决策 —");

{
  // Minted, never asserted again, and old enough that a live client would have used it.
  const r = planAttestKeyPrune(
    { dead: { signCount: 0, createdAt: NOW - 2 * DAY } },
    { now: NOW },
  );
  check("从未被断言且已过期 → 丢弃", r.drop.length === 1 && r.dead[0] === "dead");
}

{
  // Just attested; its first assertion may still be in flight.
  const r = planAttestKeyPrune(
    { fresh: { signCount: 0, createdAt: NOW - HOUR } },
    { now: NOW },
  );
  check("刚签发的 key 不丢（首次断言可能在路上）", r.drop.length === 0);
}

{
  // In real use — age alone must never evict it.
  const r = planAttestKeyPrune(
    { live: { signCount: 15, createdAt: NOW - 30 * DAY, lastUsedAt: NOW - HOUR } },
    { now: NOW },
  );
  check("在用的 key 不因年龄被丢", r.drop.length === 0);
}

{
  // Overflow evicts least-recently-active first, and activity beats creation order.
  const keys = {};
  for (let i = 0; i < 10; i++) {
    keys[`k${i}`] = { signCount: 3, createdAt: NOW - (10 - i) * DAY, lastUsedAt: NOW - (10 - i) * DAY };
  }
  keys.ancientButActive = { signCount: 9, createdAt: NOW - 99 * DAY, lastUsedAt: NOW };
  const r = planAttestKeyPrune(keys, { now: NOW, max: 5 });
  check("超出上限按最久未活动淘汰", r.kept === 5 && r.overflow.length === 6);
  check(
    "老但刚用过的 key 留下",
    !r.drop.includes("ancientButActive"),
    `drop=${r.drop.join(",")}`,
  );
}

{
  // lastUsedAt missing (rows written before the field existed) → fall back to createdAt.
  const r = planAttestKeyPrune(
    {
      old: { signCount: 2, createdAt: NOW - 40 * DAY },
      recent: { signCount: 2, createdAt: NOW - HOUR },
    },
    { now: NOW, max: 1 },
  );
  check("缺 lastUsedAt 时回退到 createdAt", r.overflow.length === 1 && r.overflow[0] === "old");
}

{
  // A row with no usable createdAt can't be aged — keeping it is the safe failure.
  const r = planAttestKeyPrune({ weird: { signCount: 0 } }, { now: NOW });
  check("createdAt 缺失/异常时保守保留", r.drop.length === 0);
  const future = planAttestKeyPrune({ skew: { signCount: 0, createdAt: NOW + DAY } }, { now: NOW });
  check("createdAt 在未来时保守保留", future.drop.length === 0);
}

{
  const r = planAttestKeyPrune({}, { now: NOW });
  check("空表不做任何事", r.drop.length === 0 && r.kept === 0);
}

{
  // The production shape: one live key among a pile of dead ones.
  const keys = { live: { signCount: 15, createdAt: NOW - 12 * HOUR, lastUsedAt: NOW - 60_000 } };
  for (let i = 0; i < 37; i++) keys[`dead${i}`] = { signCount: 0, createdAt: NOW - (2 + i) * DAY };
  const r = planAttestKeyPrune(keys, { now: NOW, max: 500 });
  check("生产形态：37 把废弃全清，在用的留下", r.drop.length === 37 && !r.drop.includes("live"));
}

console.log(`\n${failed ? "❌" : "✅"} passed=${passed} failed=${failed}`);
if (failed) process.exit(1);
