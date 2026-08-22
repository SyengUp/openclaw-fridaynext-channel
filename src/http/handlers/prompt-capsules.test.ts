// Tests for GET/PUT /friday-next/prompt-capsules — the gateway-side mirror of the app's
// prompt capsules, so a delete+reinstall (or a second device) restores them.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setMockRuntime } from "../../test-support/mock-runtime.js";
import {
  DEFAULT_SEED_CAPSULES,
  setPromptCapsulesBaseDirForTest,
} from "../../prompt-capsules/capsules-store.js";
import { handlePromptCapsules } from "./prompt-capsules.js";

type Captured = { statusCode: number; headers: Record<string, unknown>; body: string };
type IncomingMessageLike = import("node:http").IncomingMessage;
type ServerResponseLike = import("node:http").ServerResponse;

const TOKEN = "test-token";

function makeReq(method: string, body?: unknown, token: string | null = TOKEN) {
  const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const req = Readable.from(payload) as unknown as IncomingMessageLike;
  req.method = method;
  req.url = "/friday-next/prompt-capsules";
  req.headers = token ? { authorization: `Bearer ${token}` } : {};
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

async function invoke(method: string, body?: unknown, token: string | null = TOKEN) {
  const { res, captured } = makeRes();
  const handled = await handlePromptCapsules(makeReq(method, body, token), res);
  return {
    handled,
    status: captured.statusCode,
    json: captured.body ? (JSON.parse(captured.body) as Record<string, never>) : undefined,
  };
}

const CAPSULE = {
  id: "11111111-1111-1111-1111-111111111111",
  name: "Canvas",
  iconSystemName: "rectangle.on.rectangle.angled",
  prompt: "reply in canvas",
  createdAt: 1_700_000_000_000,
  sortOrder: 0,
  updatedAt: 1_700_000_000_000,
};

let dir: string;

beforeEach(() => {
  setMockRuntime({ authToken: TOKEN });
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "fn-capsules-route-"));
  setPromptCapsulesBaseDirForTest(dir);
});

afterEach(() => {
  setPromptCapsulesBaseDirForTest(null);
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("prompt-capsules route", () => {
  it("rejects a missing/mismatched bearer token", async () => {
    expect((await invoke("GET", undefined, null)).status).toBe(401);
    expect((await invoke("GET", undefined, "wrong")).status).toBe(401);
  });

  it("rejects unsupported methods", async () => {
    const { res } = makeRes();
    const req = makeReq("DELETE");
    const handled = await handlePromptCapsules(req, res);
    expect(handled).toBe(true);
  });

  it("GET on a fresh gateway plants the two starter capsules at revision 0", async () => {
    const res = await invoke("GET");
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ ok: true, revision: 0 });
    expect(res.json?.storeId).toBeTruthy();
    const capsules = res.json?.capsules as Array<{ name: string }>;
    expect(capsules.map((c) => c.name)).toEqual(DEFAULT_SEED_CAPSULES.map((c) => c.name));
  });

  it("PUT then GET round-trips the list and bumps the revision", async () => {
    const put = await invoke("PUT", { capsules: [CAPSULE] });
    expect(put.status).toBe(200);
    expect(put.json).toMatchObject({ ok: true, revision: 1 });

    const get = await invoke("GET");
    expect(get.json?.capsules).toEqual([CAPSULE]);
    expect(get.json?.revision).toBe(1);
    expect(get.json?.storeId).toBe(put.json?.storeId);
  });

  it("keeps storeId stable across writes", async () => {
    const first = await invoke("GET");
    const put = await invoke("PUT", { capsules: [CAPSULE] });
    expect(put.json?.storeId).toBe(first.json?.storeId);
  });

  it("accepts a matching baseRevision and refuses a stale one with 409 + current state", async () => {
    await invoke("PUT", { capsules: [CAPSULE], baseRevision: 0 });

    const stale = await invoke("PUT", { capsules: [], baseRevision: 0 });
    expect(stale.status).toBe(409);
    expect(stale.json).toMatchObject({ ok: false, conflict: true, revision: 1 });
    expect(stale.json?.capsules).toEqual([CAPSULE]);

    // The client re-merges against the returned revision and retries.
    const retry = await invoke("PUT", { capsules: [], baseRevision: 1 });
    expect(retry.status).toBe(200);
    expect(retry.json?.revision).toBe(2);
  });

  it("PUT without baseRevision is an unconditional replace", async () => {
    await invoke("PUT", { capsules: [CAPSULE] });
    const put = await invoke("PUT", { capsules: [] });
    expect(put.status).toBe(200);
    expect(put.json?.capsules).toEqual([]);
  });

  it("rejects a missing capsules field", async () => {
    const res = await invoke("PUT", { baseRevision: 0 });
    expect(res.status).toBe(400);
  });

  it("rejects an invalid payload without touching stored state", async () => {
    await invoke("PUT", { capsules: [CAPSULE] });
    const bad = await invoke("PUT", { capsules: [{ ...CAPSULE, prompt: "x".repeat(8001) }] });
    expect(bad.status).toBe(400);
    expect((await invoke("GET")).json?.capsules).toEqual([CAPSULE]);
  });
});
