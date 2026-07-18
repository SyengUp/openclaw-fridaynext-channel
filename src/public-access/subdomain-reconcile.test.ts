import { describe, expect, it } from "vitest";

// D31 reconcile is a pure set-diff over the served subdomains: base is always retained, the
// control-plane list adds/removes per-Apple-ID subdomains, and an unchanged set is a no-op
// (no frpc restart). We test that decision logic in isolation — the same computation
// reconcileServedSubdomains performs before deciding whether to rewrite + restart.
function decideReconcile(baseSub: string, current: string[], desired: string[]) {
  const next = Array.from(new Set([baseSub, ...desired.filter(Boolean)])).sort();
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
  it("base subdomain is always retained even if the poll omits it", () => {
    const r = decideReconcile("fnbase", ["fnbase"], []);
    expect(r.next).toEqual(["fnbase"]);
    expect(r.changed).toBe(false);
  });

  it("adds a newly-granted Apple ID subdomain", () => {
    const r = decideReconcile("fnbase", ["fnbase"], ["fnbase", "fnalice"]);
    expect(r.changed).toBe(true);
    expect(r.added).toEqual(["fnalice"]);
    expect(r.removed).toEqual([]);
    expect(r.next).toEqual(["fnalice", "fnbase"]);
  });

  it("removes a subdomain whose grant lapsed (never the base)", () => {
    const r = decideReconcile("fnbase", ["fnbase", "fnalice"], ["fnbase"]);
    expect(r.changed).toBe(true);
    expect(r.removed).toEqual(["fnalice"]);
  });

  it("dropping the base from the desired list still keeps it served", () => {
    const r = decideReconcile("fnbase", ["fnbase", "fnalice"], ["fnalice"]);
    expect(r.next).toContain("fnbase");
    expect(r.next).toContain("fnalice");
    expect(r.changed).toBe(false);
  });

  it("identical set (order/dupes aside) is a no-op — no frpc restart", () => {
    const r = decideReconcile("fnbase", ["fnbase", "fnalice"], ["fnalice", "fnalice", "fnbase"]);
    expect(r.changed).toBe(false);
  });

  it("simultaneous add + remove", () => {
    const r = decideReconcile("fnbase", ["fnbase", "fnalice"], ["fnbase", "fnbob"]);
    expect(r.changed).toBe(true);
    expect(r.added).toEqual(["fnbob"]);
    expect(r.removed).toEqual(["fnalice"]);
  });
});
