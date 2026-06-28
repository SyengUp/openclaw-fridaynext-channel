import { describe, expect, it } from "vitest";
import { buildPayload } from "./friday-approval-capability.js";

const execView = {
  approvalId: "exec:abc",
  approvalKind: "exec",
  title: "Codex command approval",
  commandText: "curl -sS https://example.com",
  commandPreview: "curl ...",
  cwd: "/ws",
  host: "sandbox",
  metadata: [{ label: "Severity", value: "Warning" }],
  actions: [
    { decision: "allow-once", label: "Allow Once", style: "primary" },
    { decision: "deny", label: "Deny", style: "danger" },
  ],
  expiresAtMs: 123,
};

const pluginView = {
  approvalId: "plugin:xyz",
  approvalKind: "plugin",
  title: "Codex app-server command approval",
  description: "Command: curl ...",
  toolName: "codex_command_approval",
  severity: "warning",
  metadata: [{ label: "Tool", value: "codex_command_approval" }],
  actions: [{ decision: "allow-always", label: "Allow Always", style: "secondary" }],
  expiresAtMs: 456,
};

const reqWith = (sessionKey: string) => ({ request: { sessionKey } });

describe("buildPayload", () => {
  it("maps an exec approval view (command/cwd/host + actions)", () => {
    const p = buildPayload({
      op: "request",
      view: execView,
      request: reqWith("agent:main:fridaynext:s1"),
      deviceId: "DEV1",
    });
    expect(p.op).toBe("request");
    expect(p.kind).toBe("exec");
    expect(p.approvalId).toBe("exec:abc");
    expect(p.commandText).toBe("curl -sS https://example.com");
    expect(p.cwd).toBe("/ws");
    expect(p.host).toBe("sandbox");
    expect(p.actions.map((a) => a.decision)).toEqual(["allow-once", "deny"]);
    expect(p.sessionKey).toBe("agent:main:fridaynext:s1");
    expect(p.deviceId).toBe("DEV1");
    expect(p.expiresAtMs).toBe(123);
  });

  it("maps a plugin approval view (toolName/severity/description)", () => {
    const p = buildPayload({
      op: "request",
      view: pluginView,
      request: reqWith("agent:main:fridaynext:s2"),
      deviceId: "DEV2",
    });
    expect(p.kind).toBe("plugin");
    expect(p.toolName).toBe("codex_command_approval");
    expect(p.severity).toBe("warning");
    expect(p.description).toBe("Command: curl ...");
    expect(p.actions[0].decision).toBe("allow-always");
    expect(p.commandText).toBeNull();
  });

  it("defaults missing fields without throwing", () => {
    const p = buildPayload({ op: "expired", view: {}, request: {}, deviceId: "D" });
    expect(p.op).toBe("expired");
    expect(p.kind).toBe("exec");
    expect(p.approvalId).toBe("");
    expect(p.actions).toEqual([]);
    expect(p.metadata).toEqual([]);
    expect(p.sessionKey).toBeNull();
  });
});
