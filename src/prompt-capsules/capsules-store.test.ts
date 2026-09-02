// Tests for the gateway-side prompt-capsule store (durable mirror of the app's capsules).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MAX_CAPSULES,
  DEFAULT_SEED_CAPSULES,
  readCapsules,
  readOrInitCapsules,
  setPromptCapsulesBaseDirForTest,
  validateCapsulesPayload,
  writeCapsules,
  type PromptCapsuleRecord,
} from "./capsules-store.js";

let dir: string;

function capsule(overrides: Partial<PromptCapsuleRecord> = {}): PromptCapsuleRecord {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    name: "Canvas",
    iconSystemName: "rectangle.on.rectangle.angled",
    prompt: "reply in canvas",
    createdAt: 1_700_000_000_000,
    sortOrder: 0,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "fn-capsules-"));
  setPromptCapsulesBaseDirForTest(dir);
});

afterEach(() => {
  setPromptCapsulesBaseDirForTest(null);
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("capsules store", () => {
  it("returns an empty store when nothing was ever written", () => {
    const state = readCapsules();
    expect(state.revision).toBe(0);
    expect(state.capsules).toEqual([]);
    expect(state.storeId).toBeTruthy();
  });

  it("mints and persists a stable storeId on first read-or-init, with the starter", () => {
    const first = readOrInitCapsules();
    const second = readOrInitCapsules();
    expect(second.storeId).toBe(first.storeId);
    expect(fs.existsSync(path.join(dir, "capsules.json"))).toBe(true);
    expect(first.revision).toBe(0);
    expect(first.capsules.map((c) => c.name)).toEqual(DEFAULT_SEED_CAPSULES.map((c) => c.name));
    expect(first.capsules.map((c) => c.prompt)).toEqual(DEFAULT_SEED_CAPSULES.map((c) => c.prompt));
  });

  it("does not re-seed an existing store, even when the user deleted every capsule", () => {
    const seeded = readOrInitCapsules();
    writeCapsules([], seeded);
    const after = readOrInitCapsules();
    expect(after.capsules).toEqual([]);
    expect(after.storeId).toBe(seeded.storeId);
  });

  it("round-trips capsules and bumps the revision, keeping storeId stable", () => {
    const initial = readOrInitCapsules();
    const written = writeCapsules([capsule()], initial);
    expect(written.revision).toBe(1);
    expect(written.storeId).toBe(initial.storeId);

    const read = readCapsules();
    expect(read.revision).toBe(1);
    expect(read.storeId).toBe(initial.storeId);
    expect(read.capsules).toEqual([capsule()]);

    const again = writeCapsules([], read);
    expect(again.revision).toBe(2);
    expect(readCapsules().capsules).toEqual([]);
  });

  it("degrades a corrupt file to an empty store instead of throwing", () => {
    fs.writeFileSync(path.join(dir, "capsules.json"), "{not json");
    const state = readCapsules();
    expect(state.capsules).toEqual([]);
    expect(state.revision).toBe(0);
  });

  it("drops unparseable entries but keeps the rest", () => {
    fs.writeFileSync(
      path.join(dir, "capsules.json"),
      JSON.stringify({
        version: 1,
        storeId: "abc",
        revision: 3,
        updatedAt: 1,
        capsules: [capsule(), { name: "no id" }, null],
      }),
    );
    const state = readCapsules();
    expect(state.storeId).toBe("abc");
    expect(state.revision).toBe(3);
    expect(state.capsules).toHaveLength(1);
  });

  it("defaults updatedAt to createdAt for records written by an older client", () => {
    fs.writeFileSync(
      path.join(dir, "capsules.json"),
      JSON.stringify({
        version: 1,
        storeId: "abc",
        revision: 1,
        updatedAt: 1,
        capsules: [{ id: "x", name: "n", iconSystemName: "i", prompt: "p", createdAt: 42 }],
      }),
    );
    const [rec] = readCapsules().capsules;
    expect(rec.updatedAt).toBe(42);
    expect(rec.sortOrder).toBe(0);
  });
});

describe("validateCapsulesPayload", () => {
  it("accepts a well-formed array", () => {
    const result = validateCapsulesPayload([capsule()]);
    expect(result.ok).toBe(true);
  });

  it("rejects a non-array", () => {
    expect(validateCapsulesPayload({}).ok).toBe(false);
  });

  it("rejects entries without an id", () => {
    const result = validateCapsulesPayload([{ name: "x" }]);
    expect(result).toMatchObject({ ok: false });
  });

  it("rejects duplicate ids", () => {
    const result = validateCapsulesPayload([capsule(), capsule()]);
    expect(result).toMatchObject({ ok: false });
  });

  it("rejects an over-long prompt", () => {
    const result = validateCapsulesPayload([capsule({ prompt: "x".repeat(8001) })]);
    expect(result).toMatchObject({ ok: false });
  });

  it("rejects more than the capsule cap", () => {
    const many = Array.from({ length: MAX_CAPSULES + 1 }, (_, i) => capsule({ id: `id-${i}` }));
    expect(validateCapsulesPayload(many).ok).toBe(false);
  });
});
