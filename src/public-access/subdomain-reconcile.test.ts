import { describe, expect, it } from "vitest";
import { normalizedServedSubdomains } from "./frpc-manager.js";

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
