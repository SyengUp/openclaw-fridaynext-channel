// Tests for GET/PUT /friday-next/agents/{id}/greeting — a single agent's home-greeting
// override, stored gateway-side so every paired device shows the same greeting.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  readGreetingFor,
  setAgentGreetingsBaseDirForTest,
} from "../../agent-greetings/greetings-store.js";
import { setMockRuntime } from "../../test-support/mock-runtime.js";
import { handleAgentGreeting } from "./agent-greetings.js";

type Captured = { statusCode: number; body: string };
type IncomingMessageLike = import("node:http").IncomingMessage;
type ServerResponseLike = import("node:http").ServerResponse;

const TOKEN = "test-token";

function makeReq(method: string, body?: unknown, token: string | null = TOKEN) {
  const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const req = Readable.from(payload) as unknown as IncomingMessageLike;
  req.method = method;
  req.url = "/friday-next/agents/main/greeting";
  req.headers = token ? { authorization: `Bearer ${token}` } : {};
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

async function invoke(method: string, body?: unknown, token: string | null = TOKEN, agentId = "main") {
  const { res, captured } = makeRes();
  const handled = await handleAgentGreeting(makeReq(method, body, token), res, agentId);
  return {
    handled,
    status: captured.statusCode,
    json: captured.body ? (JSON.parse(captured.body) as Record<string, unknown>) : undefined,
  };
}

let dir: string;

beforeEach(() => {
  setMockRuntime({ authToken: TOKEN });
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "fn-agent-greetings-handler-"));
  setAgentGreetingsBaseDirForTest(dir);
});

afterEach(() => {
  setAgentGreetingsBaseDirForTest(null);
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("handleAgentGreeting", () => {
  it("rejects non-GET/PUT methods with 405", async () => {
    const r = await invoke("DELETE");
    expect(r.handled).toBe(true);
    expect(r.status).toBe(405);
  });

  it("rejects a missing bearer token with 401", async () => {
    const r = await invoke("GET", undefined, null);
    expect(r.status).toBe(401);
  });

  it("GET returns null greeting when no override exists", async () => {
    const r = await invoke("GET");
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true, greeting: null });
  });

  it("PUT stores the greeting and GET returns it", async () => {
    const put = await invoke("PUT", { greeting: "早上好" });
    expect(put.status).toBe(200);
    expect(put.json).toEqual({ ok: true, greeting: "早上好" });
    expect(readGreetingFor("main")).toBe("早上好");

    const get = await invoke("GET");
    expect(get.json).toEqual({ ok: true, greeting: "早上好" });
  });

  it("PUT with empty string clears the override", async () => {
    await invoke("PUT", { greeting: "早上好" });
    const cleared = await invoke("PUT", { greeting: "" });
    expect(cleared.status).toBe(200);
    expect(cleared.json).toEqual({ ok: true, greeting: null });
    expect(readGreetingFor("main")).toBeUndefined();
  });

  it("PUT without the greeting field is 400", async () => {
    const r = await invoke("PUT", {});
    expect(r.status).toBe(400);
  });

  it("PUT with a non-string greeting is 400", async () => {
    const r = await invoke("PUT", { greeting: 42 });
    expect(r.status).toBe(400);
  });

  it("PUT with an over-length greeting is 400", async () => {
    const r = await invoke("PUT", { greeting: "问".repeat(61) });
    expect(r.status).toBe(400);
  });

  it("stores per-agent: each agent keeps its own greeting", async () => {
    await invoke("PUT", { greeting: "Alpha 你好" }, TOKEN, "alpha");
    await invoke("PUT", { greeting: "Beta 你好" }, TOKEN, "beta");
    expect(readGreetingFor("alpha")).toBe("Alpha 你好");
    expect(readGreetingFor("beta")).toBe("Beta 你好");
    expect(readGreetingFor("main")).toBeUndefined();
  });
});
