import { describe, expect, it } from "vitest";
import { fridayNextChannelPlugin } from "./channel.js";

describe("friday-next legacy outbound target parsing", () => {
  const messaging = (fridayNextChannelPlugin as { messaging?: Record<string, unknown> }).messaging;

  it("preserves an explicit device id for OpenClaw 2026.7.1 cron delivery", () => {
    const parse = messaging?.parseExplicitTarget as (params: { raw?: string }) => {
      to?: string;
    };

    expect(parse({ raw: " device-cron-271 " })).toEqual({ to: "device-cron-271" });
  });

  it("keeps the channel placeholder only when no explicit target exists", () => {
    const parse = messaging?.parseExplicitTarget as (params: { raw?: string }) => {
      to?: string;
    };

    expect(parse({})).toEqual({ to: "friday-next" });
  });
});
