import { describe, expect, it } from "vitest";
import { nodePairingModuleCandidates } from "./node-pairing-bridge.js";

describe("nodePairingModuleCandidates", () => {
  it("prefers OpenClaw 2026.8.1 device-pairing-node chunk over leftover node-pairing-* files", () => {
    expect(
      nodePairingModuleCandidates([
        "node-pairing-authz-aaaa.js",
        "node-pairing-migration-bbbb.js",
        "device-pairing-node-cccc.js",
        "readme.md",
      ]),
    ).toEqual(["device-pairing-node-cccc.js"]);
  });

  it("falls back to the 2026.7.x node-pairing chunk", () => {
    expect(
      nodePairingModuleCandidates(["node-pairing-dddd.js", "node-pairing-authz-eeee.js"]),
    ).toEqual(["node-pairing-dddd.js"]);
  });
});
