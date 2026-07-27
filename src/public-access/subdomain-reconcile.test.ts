import { describe, expect, it } from "vitest";
import { isValidSubdomainLabel, normalizedServedSubdomains } from "./frpc-manager.js";

// D31 reconcile is a pure set-diff over the served subdomains: the control-plane list is
// authoritative (including empty), and an unchanged set is a no-op
// (no frpc restart). We test that decision logic in isolation — the same computation
// reconcileServedSubdomains performs before deciding whether to rewrite + restart.
function decideReconcile(current: string[], desired: string[]) {
  const next = normalizedServedSubdomains(desired);
  const cur = Array.from(new Set(current)).sort();
  const changed = !(next.length === cur.length && next.every((s, i) => s === cur[i]));
  return {
    changed,
    next,
    added: next.filter((s) => !cur.includes(s)),
    removed: cur.filter((s) => !next.includes(s)),
  };
}

describe("D31 served-subdomain reconcile", () => {
  it("removes the base subdomain when the entitlement list becomes empty", () => {
    const r = decideReconcile(["fnbase"], []);
    expect(r.next).toEqual([]);
    expect(r.removed).toEqual(["fnbase"]);
    expect(r.changed).toBe(true);
  });

  it("adds a newly-granted Apple ID subdomain", () => {
    const r = decideReconcile(["fnbase"], ["fnbase", "fnalice"]);
    expect(r.changed).toBe(true);
    expect(r.added).toEqual(["fnalice"]);
    expect(r.removed).toEqual([]);
    expect(r.next).toEqual(["fnalice", "fnbase"]);
  });

  it("removes a subdomain whose grant lapsed", () => {
    const r = decideReconcile(["fnbase", "fnalice"], ["fnbase"]);
    expect(r.changed).toBe(true);
    expect(r.removed).toEqual(["fnalice"]);
  });

  it("can drop the base while retaining another entitled Apple-ID subdomain", () => {
    const r = decideReconcile(["fnbase", "fnalice"], ["fnalice"]);
    expect(r.next).toEqual(["fnalice"]);
    expect(r.removed).toEqual(["fnbase"]);
    expect(r.changed).toBe(true);
  });

  it("identical set (order/dupes aside) is a no-op — no frpc restart", () => {
    const r = decideReconcile(["fnbase", "fnalice"], ["fnalice", "fnalice", "fnbase"]);
    expect(r.changed).toBe(false);
  });

  it("simultaneous add + remove", () => {
    const r = decideReconcile(["fnbase", "fnalice"], ["fnbase", "fnbob"]);
    expect(r.changed).toBe(true);
    expect(r.added).toEqual(["fnbob"]);
    expect(r.removed).toEqual(["fnalice"]);
  });
});

// These strings are interpolated into frpc.toml (`subdomain = "…"`) and into a cert filename
// (`sub-<label>.pem`). A quote/newline would be config injection; a `../` would write outside the
// plugin data dir. The control plane is first-party — this is the cheap structural guarantee.
describe("subdomain label validation", () => {
  it("accepts the allocator's shape", () => {
    expect(isValidSubdomainLabel("fn02ddc9842d")).toBe(true);
    expect(isValidSubdomainLabel("a")).toBe(true);
    expect(isValidSubdomainLabel("fn-alice-2")).toBe(true);
  });

  it("rejects anything that could escape the config or the data dir", () => {
    for (const bad of [
      '"',
      'fnbase"\nname = "evil',
      "../../.ssh/authorized_keys",
      "fn base",
      "-leading",
      "trailing-",
      "FNUPPER",
      "",
      "x".repeat(64),
    ]) {
      expect(isValidSubdomainLabel(bad)).toBe(false);
    }
  });

  it("malformed entries are dropped from the served set, valid ones survive", () => {
    const r = decideReconcile(["fnbase"], ["fnbase", 'evil"\nname = "x', "fnalice"]);
    expect(r.next).toEqual(["fnalice", "fnbase"]);
  });
});
