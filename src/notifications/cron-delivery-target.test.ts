import { describe, expect, it } from "vitest";
import { readCronDeliveryTarget } from "./cron-delivery-target.js";

describe("readCronDeliveryTarget", () => {
  it("recognises a friday-next announce job (the real 每日科技 shape)", () => {
    expect(
      readCronDeliveryTarget({
        id: "aca31947",
        name: "每日科技",
        delivery: { mode: "announce", channel: "friday-next", bestEffort: false },
      }),
    ).toEqual({ deliversToFridayNext: true, to: null });
  });

  it("captures a pinned target device, uppercased", () => {
    expect(
      readCronDeliveryTarget({
        delivery: { mode: "announce", channel: "friday-next", to: "8dde95de-92a1" },
      }).to,
    ).toBe("8DDE95DE-92A1");
  });

  it("excludes a job that announces to another channel", () => {
    expect(
      readCronDeliveryTarget({ delivery: { mode: "announce", channel: "telegram" } }),
    ).toEqual({ deliversToFridayNext: false, to: null });
  });

  // `cron add --no-deliver` writes {mode:"none", channel:"last"} — announces nothing, but its turn
  // can still push via the `message` tool, so it must stay eligible (just outranked).
  it("treats a no-delivery job as unknown, not excluded", () => {
    expect(
      readCronDeliveryTarget({ delivery: { mode: "none", channel: "last" } }).deliversToFridayNext,
    ).toBeNull();
  });

  it("treats a placeholder channel as unknown (it may resolve to friday-next)", () => {
    expect(
      readCronDeliveryTarget({ delivery: { mode: "announce", channel: "last" } })
        .deliversToFridayNext,
    ).toBeNull();
  });

  it("treats a job with no delivery block as UNKNOWN, not excluded (message-tool crons)", () => {
    expect(readCronDeliveryTarget({ id: "j", name: "巡检" }).deliversToFridayNext).toBeNull();
  });

  it("treats an announce with no explicit channel as unknown (origin-channel fallback)", () => {
    expect(readCronDeliveryTarget({ delivery: { mode: "announce" } }).deliversToFridayNext).toBeNull();
  });

  it("degrades to unknown for a missing / malformed job", () => {
    expect(readCronDeliveryTarget(undefined).deliversToFridayNext).toBeNull();
    expect(readCronDeliveryTarget(null).deliversToFridayNext).toBeNull();
    expect(readCronDeliveryTarget("nope").deliversToFridayNext).toBeNull();
  });
});
