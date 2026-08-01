// Tests for GET /friday-next-admin/commands — slash-command catalog for the app
// composer menu, forwarded to the canonical gateway `commands.list` method.
import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleCommandsList } from "./commands-list.js";

const { dispatchGatewayMethod } = vi.hoisted(() => ({
  dispatchGatewayMethod: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/gateway-method-runtime", () => ({
  dispatchGatewayMethod,
}));

type Captured = { statusCode: number; headers: Record<string, unknown>; body: string };
type IncomingMessageLike = import("node:http").IncomingMessage;
type ServerResponseLike = import("node:http").ServerResponse;

function makeReq(method: string, url: string): IncomingMessageLike {
  const req = Readable.from([]) as unknown as IncomingMessageLike;
  req.method = method;
  req.url = url;
  req.headers = {};
  return req;
}

function makeRes(): { res: ServerResponseLike; captured: Captured } {
  const captured: Captured = { statusCode: 200, headers: {}, body: "" };
  const res = {
    get statusCode() {
      return captured.statusCode;
    },
    set statusCode(v: number) {
      captured.statusCode = v;
    },
    setHeader(name: string, value: unknown) {
      captured.headers[name.toLowerCase()] = value;
    },
    end(chunk?: string | Buffer) {
      captured.body = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : (chunk ?? "");
    },
  } as unknown as ServerResponseLike;
  return { res, captured };
}

async function invoke(method: string, url: string) {
  const { res, captured } = makeRes();
  const handled = await handleCommandsList(makeReq(method, url), res);
  return {
    handled,
    captured,
    json: captured.body ? (JSON.parse(captured.body) as Record<string, unknown>) : undefined,
  };
}

const SAMPLE_COMMANDS = [
  {
    name: "new",
    textAliases: ["/new"],
    description: "Start a new session.",
    category: "session",
    source: "native",
    scope: "both",
    acceptsArgs: true,
  },
  {
    name: "think",
    textAliases: ["/think", "/thinking", "/t"],
    description: "Set thinking level.",
    category: "options",
    source: "native",
    scope: "both",
    acceptsArgs: true,
    args: [{ name: "level", description: "Thinking level", type: "string", dynamic: true }],
  },
];

describe("handleCommandsList", () => {
  beforeEach(() => {
    dispatchGatewayMethod.mockReset();
  });

  it("dispatches commands.list for the requested agent and returns the catalog", async () => {
    dispatchGatewayMethod.mockResolvedValue({ ok: true, payload: { commands: SAMPLE_COMMANDS } });

    const { captured, json } = await invoke("GET", "/friday-next-admin/commands?agentId=friday");

    expect(dispatchGatewayMethod).toHaveBeenCalledWith("commands.list", {
      agentId: "friday",
      scope: "text",
      includeArgs: true,
    });
    expect(captured.statusCode).toBe(200);
    expect(json).toMatchObject({ ok: true, agentId: "friday", commands: SAMPLE_COMMANDS });
  });

  it("defaults a missing agentId to main", async () => {
    dispatchGatewayMethod.mockResolvedValue({ ok: true, payload: { commands: [] } });

    await invoke("GET", "/friday-next-admin/commands");

    expect(dispatchGatewayMethod).toHaveBeenCalledWith("commands.list", {
      agentId: "main",
      scope: "text",
      includeArgs: true,
    });
  });

  it("normalizes an unsafe agentId the same way session keys do", async () => {
    dispatchGatewayMethod.mockResolvedValue({ ok: true, payload: { commands: [] } });

    await invoke("GET", "/friday-next-admin/commands?agentId=My%20Agent");

    expect(dispatchGatewayMethod).toHaveBeenCalledWith(
      "commands.list",
      expect.objectContaining({ agentId: "my-agent" }),
    );
  });

  it("returns 405 for non-GET methods", async () => {
    const { captured } = await invoke("POST", "/friday-next-admin/commands");
    expect(captured.statusCode).toBe(405);
    expect(dispatchGatewayMethod).not.toHaveBeenCalled();
  });

  // Soft failure: the app falls back to its built-in table, so an old gateway
  // without `commands.list` must not break the menu with a 5xx.
  it("returns 200 with an empty list when the gateway method errors", async () => {
    dispatchGatewayMethod.mockResolvedValue({
      ok: false,
      error: { code: "INVALID_REQUEST", message: "unknown method" },
    });

    const { captured, json } = await invoke("GET", "/friday-next-admin/commands");

    expect(captured.statusCode).toBe(200);
    expect(json).toMatchObject({ ok: false, commands: [], code: "INVALID_REQUEST" });
  });

  it("returns 200 with an empty list when dispatch throws", async () => {
    dispatchGatewayMethod.mockRejectedValue(new Error("dispatch reserved for contracts"));

    const { captured, json } = await invoke("GET", "/friday-next-admin/commands");

    expect(captured.statusCode).toBe(200);
    expect(json).toMatchObject({ ok: false, commands: [] });
  });

  it("tolerates a payload without a commands array", async () => {
    dispatchGatewayMethod.mockResolvedValue({ ok: true, payload: {} });

    const { json } = await invoke("GET", "/friday-next-admin/commands");

    expect(json).toMatchObject({ ok: true, commands: [] });
  });
});
