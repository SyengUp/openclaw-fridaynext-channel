import { describe, expect, it } from "vitest";

import { planAttestKeyPrune } from "./attest-key-prune.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = 1_000 * DAY;

describe("planAttestKeyPrune", () => {
  it("drops a key that was never asserted and is old enough", () => {
    const plan = planAttestKeyPrune({ dead: { signCount: 0, createdAt: NOW - 2 * DAY } }, { now: NOW });
    expect(plan.dead).toEqual(["dead"]);
  });

  it("keeps a freshly attested key whose first assertion may still be in flight", () => {
    const plan = planAttestKeyPrune({ fresh: { signCount: 0, createdAt: NOW - HOUR } }, { now: NOW });
    expect(plan.drop).toEqual([]);
  });

  it("never evicts a key in real use on age alone", () => {
    const plan = planAttestKeyPrune(
      { live: { signCount: 15, createdAt: NOW - 30 * DAY, lastUsedAt: NOW - HOUR } },
      { now: NOW },
    );
    expect(plan.drop).toEqual([]);
  });

  it("evicts least-recently-active first on overflow, ranking activity over creation", () => {
    const keys: Record<string, { signCount: number; createdAt: number; lastUsedAt: number }> = {};
    for (let i = 0; i < 10; i++) {
      keys[`k${i}`] = {
        signCount: 3,
        createdAt: NOW - (10 - i) * DAY,
        lastUsedAt: NOW - (10 - i) * DAY,
      };
    }
    keys.ancientButActive = { signCount: 9, createdAt: NOW - 99 * DAY, lastUsedAt: NOW };

    const plan = planAttestKeyPrune(keys, { now: NOW, max: 5 });

    expect(plan.kept).toBe(5);
    expect(plan.overflow).toHaveLength(6);
    expect(plan.drop).not.toContain("ancientButActive");
  });

  it("falls back to createdAt when lastUsedAt is absent", () => {
    const plan = planAttestKeyPrune(
      {
        old: { signCount: 2, createdAt: NOW - 40 * DAY },
        recent: { signCount: 2, createdAt: NOW - HOUR },
      },
      { now: NOW, max: 1 },
    );
    expect(plan.overflow).toEqual(["old"]);
  });

  it("keeps rows it cannot age", () => {
    expect(planAttestKeyPrune({ noDate: { signCount: 0 } }, { now: NOW }).drop).toEqual([]);
    expect(
      planAttestKeyPrune({ skew: { signCount: 0, createdAt: NOW + DAY } }, { now: NOW }).drop,
    ).toEqual([]);
  });

  it("handles the production shape: one live key among a pile of dead ones", () => {
    const keys: Record<string, { signCount: number; createdAt: number; lastUsedAt?: number }> = {
      live: { signCount: 15, createdAt: NOW - 12 * HOUR, lastUsedAt: NOW - 60_000 },
    };
    for (let i = 0; i < 37; i++) keys[`dead${i}`] = { signCount: 0, createdAt: NOW - (2 + i) * DAY };

    const plan = planAttestKeyPrune(keys, { now: NOW, max: 200 });

    expect(plan.drop).toHaveLength(37);
    expect(plan.drop).not.toContain("live");
    expect(plan.kept).toBe(1);
  });

  it("does nothing on an empty table", () => {
    expect(planAttestKeyPrune({}, { now: NOW })).toMatchObject({ drop: [], kept: 0 });
  });
});
