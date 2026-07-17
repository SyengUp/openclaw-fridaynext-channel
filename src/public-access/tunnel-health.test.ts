import { describe, it, expect } from "vitest";
import { TunnelHealthTracker } from "./frpc-manager.js";

describe("TunnelHealthTracker（隧道自愈看门狗计数器）", () => {
  it("restarts only after N consecutive failures", () => {
    const t = new TunnelHealthTracker(3);
    expect(t.note(false)).toBe(false);
    expect(t.note(false)).toBe(false);
    expect(t.note(false)).toBe(true); // 3rd strike → restart
  });

  it("a success resets the strike counter", () => {
    const t = new TunnelHealthTracker(3);
    t.note(false);
    t.note(false);
    expect(t.note(true)).toBe(false); // healthy probe wipes strikes
    expect(t.note(false)).toBe(false);
    expect(t.note(false)).toBe(false);
    expect(t.note(false)).toBe(true); // needs 3 fresh consecutive failures again
  });

  it("resets after firing so a still-dead tunnel retries every N probes (bounded relay load)", () => {
    const t = new TunnelHealthTracker(3);
    t.note(false);
    t.note(false);
    expect(t.note(false)).toBe(true);
    expect(t.consecutiveFailures).toBe(0);
    // Tunnel stays dead (e.g. still unpaid) → next restart only after another full window.
    expect(t.note(false)).toBe(false);
    expect(t.note(false)).toBe(false);
    expect(t.note(false)).toBe(true);
  });

  it("healthy steady-state never restarts", () => {
    const t = new TunnelHealthTracker(3);
    for (let i = 0; i < 10; i += 1) {
      expect(t.note(true)).toBe(false);
    }
    expect(t.consecutiveFailures).toBe(0);
  });
});
