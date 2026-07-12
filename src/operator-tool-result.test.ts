import { describe, expect, it } from "vitest";
import { isOperatorToolResultEnvelope } from "./operator-tool-result.js";

describe("isOperatorToolResultEnvelope", () => {
  it("matches the real captured gateway.restart receipt", () => {
    const text =
      "Gateway restart ok (gateway.restart)\n" +
      "网关正在重启，我会等它恢复后确认一下。\n" +
      "Reason: User requested gateway restart\n" +
      "Recommended follow-up: run openclaw doctor --non-interactive in a terminal or approvals-capable OpenClaw surface.";
    expect(isOperatorToolResultEnvelope(text)).toBe(true);
  });

  it("matches other operator namespaces (config / node) with either advisory line", () => {
    expect(
      isOperatorToolResultEnvelope("Config updated ok (config.set)\nReason: apply model default"),
    ).toBe(true);
    expect(
      isOperatorToolResultEnvelope(
        "Node repaired (node.repair)\nRecommended follow-up: verify pairing",
      ),
    ).toBe(true);
  });

  it("matches a failed operator result too", () => {
    expect(
      isOperatorToolResultEnvelope(
        "Gateway restart failed (gateway.restart)\nReason: process is locked",
      ),
    ).toBe(true);
  });

  it("does NOT match a normal reply that only quotes one signal", () => {
    // method header alone (someone discussing openclaw) — no advisory line
    expect(isOperatorToolResultEnvelope("You can call (gateway.restart) from the CLI.")).toBe(false);
    // advisory phrase alone in prose — no parenthesised method header
    expect(
      isOperatorToolResultEnvelope("Reason: because I said so. Here's my recommended follow-up."),
    ).toBe(false);
  });

  it("does NOT match ordinary agent replies", () => {
    expect(isOperatorToolResultEnvelope("好的，我帮你把网关重启一下。")).toBe(false);
    expect(isOperatorToolResultEnvelope("Here is the summary you asked for.")).toBe(false);
    expect(isOperatorToolResultEnvelope("")).toBe(false);
    expect(isOperatorToolResultEnvelope(null)).toBe(false);
    expect(isOperatorToolResultEnvelope(undefined)).toBe(false);
  });
});
