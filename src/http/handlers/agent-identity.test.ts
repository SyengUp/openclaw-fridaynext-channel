// Tests for PUT /friday-next-admin/agents/identity — agent rename via the
// canonical gateway `agents.update` method.
import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { dispatchGatewayMethod } = vi.hoisted(() => ({ dispatchGatewayMethod: vi.fn() }));
vi.mock("openclaw/plugin-sdk/gateway-method-runtime", () => ({ dispatchGatewayMethod }));

const { getConfig, mutateConfigFile } = vi.hoisted(() => ({
  getConfig: vi.fn(),
  mutateConfigFile: vi.fn(),
}));
vi.mock("../../agent-forward-runtime.js", () => ({
  getFridayAgentForwardRuntime: () => ({ getConfig }),
}));
vi.mock("../../upgrade-runtime.js", () => ({
  getUpgradeRuntime: () => ({ mutateConfigFile }),
}));

import { handleAgentIdentity, sanitizeAgentName } from "./agent-identity.js";

type IncomingMessageLike = import("node:http").IncomingMessage;
type ServerResponseLike = import("node:http").ServerResponse;
type Captured = { statusCode: number; body: string };

function makeReq(method: string, body?: unknown): IncomingMessageLike {
  const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body), "utf-8")];
  const req = Readable.from(payload) as unknown as IncomingMessageLike;
  req.method = method;
  req.url = "/friday-next-admin/agents/identity";
  req.headers = {};
  return req;
}

function makeRes(): { res: ServerResponseLike; captured: Captured } {
  const captured: Captured = { statusCode: 200, body: "" };
  const res = {
    get statusCode() {
      return captured.statusCode;
    },
    set statusCode(v: number) {
      captured.statusCode = v;
    },
    setHeader() {},
    end(chunk?: string | Buffer) {
      captured.body = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : (chunk ?? "");
    },
  } as unknown as ServerResponseLike;
  return { res, captured };
}

async function invoke(method: string, body?: unknown) {
  const { res, captured } = makeRes();
  await handleAgentIdentity(makeReq(method, body), res);
  return {
    status: captured.statusCode,
    json: captured.body ? (JSON.parse(captured.body) as Record<string, unknown>) : undefined,
  };
}

/** Applies the recorded `mutate` callbacks against a draft, like the real config runtime. */
function runMutations(draft: Record<string, unknown>): Record<string, unknown> {
  for (const call of mutateConfigFile.mock.calls) {
    (call[0] as { mutate: (d: unknown) => unknown }).mutate(draft);
  }
  return draft;
}

describe("handleAgentIdentity", () => {
  beforeEach(() => {
    dispatchGatewayMethod.mockReset();
    dispatchGatewayMethod.mockResolvedValue({ ok: true, payload: { ok: true, agentId: "main" } });
    mutateConfigFile.mockReset();
    mutateConfigFile.mockResolvedValue(undefined);
    getConfig.mockReset();
    getConfig.mockReturnValue({ agents: { list: [{ id: "main" }] } });
  });

  it("rejects non-PUT", async () => {
    expect((await invoke("GET")).status).toBe(405);
  });

  it("rejects a missing agentId or name", async () => {
    expect((await invoke("PUT", { name: "F" })).status).toBe(400);
    expect((await invoke("PUT", { agentId: "main" })).status).toBe(400);
    expect((await invoke("PUT", { agentId: "main", name: "   " })).status).toBe(400);
  });

  it("rejects a name past the 50-char identity cap", async () => {
    const res = await invoke("PUT", { agentId: "main", name: "x".repeat(51) });
    expect(res.status).toBe(400);
    expect(dispatchGatewayMethod).not.toHaveBeenCalled();
  });

  it("dispatches agents.update with the sanitized single-line name", async () => {
    const res = await invoke("PUT", { agentId: "MAIN", name: "  星期五   (Friday)\n" });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ ok: true, agentId: "main", name: "星期五 (Friday)" });
    expect(dispatchGatewayMethod).toHaveBeenCalledWith("agents.update", {
      agentId: "main",
      name: "星期五 (Friday)",
    });
  });

  it("materializes an agents.list entry for an implicit main before dispatching", async () => {
    getConfig.mockReturnValue({ agents: { defaults: {} } });
    await invoke("PUT", { agentId: "main", name: "Friday" });
    const draft = runMutations({ agents: { defaults: {} } });
    const list = (draft.agents as { list?: Array<Record<string, unknown>> }).list ?? [];
    expect(list).toEqual([{ id: "main" }]);
    // Never flag `default: true` — that would pin default-agent resolution.
    expect(list[0]).not.toHaveProperty("default");
    expect(dispatchGatewayMethod).toHaveBeenCalled();
  });

  it("does not touch agents.list when the entry already exists", async () => {
    await invoke("PUT", { agentId: "main", name: "Friday" });
    expect(mutateConfigFile).not.toHaveBeenCalled();
  });

  it("keeps an existing ui.assistant.name in sync for the default agent", async () => {
    getConfig.mockReturnValue({
      agents: { list: [{ id: "main" }] },
      ui: { assistant: { name: "Old" } },
    });
    const res = await invoke("PUT", { agentId: "main", name: "Friday" });
    expect(res.json).toMatchObject({ uiAssistantSynced: true });
    const draft = runMutations({ ui: { assistant: { name: "Old" } } });
    expect((draft.ui as { assistant: { name: string } }).assistant.name).toBe("Friday");
  });

  it("never creates a ui.assistant.name override that wasn't there", async () => {
    await invoke("PUT", { agentId: "main", name: "Friday" });
    expect(mutateConfigFile).not.toHaveBeenCalled();
  });

  it("leaves ui.assistant.name alone for a non-default agent", async () => {
    getConfig.mockReturnValue({
      agents: { list: [{ id: "main" }, { id: "operator" }] },
      ui: { assistant: { name: "Old" } },
    });
    const res = await invoke("PUT", { agentId: "operator", name: "Ops" });
    expect(res.json).toMatchObject({ ok: true, uiAssistantSynced: false });
    expect(mutateConfigFile).not.toHaveBeenCalled();
  });

  it("maps a gateway error envelope to an HTTP status", async () => {
    dispatchGatewayMethod.mockResolvedValue({
      ok: false,
      error: { code: "INVALID_REQUEST", message: 'agent "ghost" not found' },
    });
    const res = await invoke("PUT", { agentId: "ghost", name: "Ghost" });
    expect(res.status).toBe(400);
    expect(res.json).toMatchObject({ ok: false, code: "INVALID_REQUEST" });
  });
});

describe("sanitizeAgentName", () => {
  it("collapses whitespace and trims", () => {
    expect(sanitizeAgentName("  a \n b  ")).toBe("a b");
    expect(sanitizeAgentName(42)).toBe("");
  });
});
