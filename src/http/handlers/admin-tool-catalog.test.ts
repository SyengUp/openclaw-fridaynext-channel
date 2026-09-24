// Tests for GET /friday-next-admin/tool-catalog — agent tool catalog for the app
// toolbox editor, forwarded to the canonical gateway `tools.catalog` method.
import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleAdminToolCatalog } from "./admin-tool-catalog.js";

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
  const handled = await handleAdminToolCatalog(makeReq(method, url), res);
  return {
    handled,
    captured,
    json: captured.body ? (JSON.parse(captured.body) as Record<string, unknown>) : undefined,
  };
}

const CATALOG = {
  agentId: "main",
  profiles: [{ id: "minimal", label: "Minimal" }],
  groups: [
    {
      id: "fs",
      label: "Files",
      source: "core",
      tools: [
        {
          id: "read",
          label: "Read",
          description: "read files",
          source: "core",
          defaultProfiles: ["minimal"],
        },
      ],
    },
  ],
};

describe("handleAdminToolCatalog", () => {
  beforeEach(() => {
    dispatchGatewayMethod.mockReset();
  });

  it("dispatches tools.catalog for the requested agent and returns the projected catalog", async () => {
    dispatchGatewayMethod.mockResolvedValue({ ok: true, payload: CATALOG });

    const { captured, json } = await invoke(
      "GET",
      "/friday-next-admin/tool-catalog?agentId=friday",
    );

    expect(dispatchGatewayMethod).toHaveBeenCalledWith("tools.catalog", {
      agentId: "friday",
      includePlugins: true,
    });
    expect(captured.statusCode).toBe(200);
    expect(json).toMatchObject({ ok: true, id: "friday" });
    expect((json!.groups as unknown[]).length).toBe(1);
  });

  it("defaults a missing agentId to main", async () => {
    dispatchGatewayMethod.mockResolvedValue({ ok: true, payload: CATALOG });

    await invoke("GET", "/friday-next-admin/tool-catalog");

    expect(dispatchGatewayMethod).toHaveBeenCalledWith("tools.catalog", {
      agentId: "main",
      includePlugins: true,
    });
  });

  it("normalizes an unsafe agentId the same way session keys do", async () => {
    dispatchGatewayMethod.mockResolvedValue({ ok: true, payload: CATALOG });

    await invoke("GET", "/friday-next-admin/tool-catalog?agentId=My%20Agent");

    expect(dispatchGatewayMethod).toHaveBeenCalledWith(
      "tools.catalog",
      expect.objectContaining({ agentId: "my-agent" }),
    );
  });

  it("returns 405 for non-GET methods", async () => {
    const { captured } = await invoke("POST", "/friday-next-admin/tool-catalog");
    expect(captured.statusCode).toBe(405);
    expect(dispatchGatewayMethod).not.toHaveBeenCalled();
  });

  it("returns 503 when the gateway method errors", async () => {
    dispatchGatewayMethod.mockResolvedValue({
      ok: false,
      error: { code: "FORBIDDEN", message: "missing scope: operator.read" },
    });

    const { captured, json } = await invoke("GET", "/friday-next-admin/tool-catalog");

    expect(captured.statusCode).toBe(503);
    expect(json).toMatchObject({ error: "Tool catalog unavailable" });
  });

  it("returns 503 when dispatch throws", async () => {
    dispatchGatewayMethod.mockRejectedValue(new Error("no scope"));

    const { captured } = await invoke("GET", "/friday-next-admin/tool-catalog");

    expect(captured.statusCode).toBe(503);
  });
});
