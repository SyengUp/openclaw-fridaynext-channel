import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleSessionsSettings } from "./sessions-settings.js";
import { setMockRuntime } from "../../test-support/mock-runtime.js";
import {
  setFridayAgentForwardRuntime,
  resetFridayAgentForwardRuntimeForTest,
} from "../../agent-forward-runtime.js";

class MockRes extends EventEmitter {
  statusCode = 0;
  headers: Record<string, string> = {};
  body = "";
  setHeader(name: string, value: string): void {
    this.headers[name.toLowerCase()] = value;
  }
  end(body?: string): void {
    if (body) this.body += body;
  }
}

const AUTH = { authorization: "Bearer test-token" };

function makeGet(sessionKey: string): any {
  return {
    method: "GET",
    url: `/friday-next/sessions/settings?sessionKey=${encodeURIComponent(sessionKey)}`,
    headers: AUTH,
  };
}

function makePut(bodyObj: unknown): any {
  const req = Readable.from([Buffer.from(JSON.stringify(bodyObj))]) as any;
  req.method = "PUT";
  req.url = "/friday-next/sessions/settings";
  req.headers = AUTH;
  return req;
}

describe("handleSessionsSettings permissionMode", () => {
  let baseDir: string;

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), "fn-sess-settings-"));
    const sessionsDir = join(baseDir, ".openclaw", "agents", "main", "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, "sessions.json"), JSON.stringify({}), "utf-8");
    const historyDir = join(baseDir, ".openclaw", "friday-next", "history");
    mkdirSync(historyDir, { recursive: true });
    setMockRuntime({ historyDir });
    setFridayAgentForwardRuntime({
      runtime: {
        agent: {
          session: {
            resolveStorePath: () => join(sessionsDir, "sessions.json"),
            loadSessionStore: () => ({}),
          },
        },
        config: { current: () => ({ gateway: { auth: { token: "test-token" } } }) },
      },
    } as any);
  });

  afterEach(() => {
    resetFridayAgentForwardRuntimeForTest();
    rmSync(baseDir, { recursive: true, force: true });
  });

  it("rejects non-GET/PUT with 405", async () => {
    const res = new MockRes();
    await handleSessionsSettings({ method: "POST", headers: AUTH, url: "/" } as any, res as any);
    expect(res.statusCode).toBe(405);
  });

  it("PUTs permissionMode and GETs it back", async () => {
    const putRes = new MockRes();
    await handleSessionsSettings(
      makePut({ sessionKey: "main", permissionMode: "workspace" }),
      putRes as any,
    );
    expect(putRes.statusCode).toBe(200);
    const putBody = JSON.parse(putRes.body);
    expect(putBody.permissionMode).toBe("workspace");

    const entryPath = join(baseDir, ".openclaw", "agents", "main", "sessions", "sessions.json");
    const stored = JSON.parse(readFileSync(entryPath, "utf-8"));
    expect(stored["agent:main:main"].permissionMode).toBe("workspace");

    const getRes = new MockRes();
    await handleSessionsSettings(makeGet("main"), getRes as any);
    expect(getRes.statusCode).toBe(200);
    expect(JSON.parse(getRes.body).permissionMode).toBe("workspace");
  });

  it("clears permissionMode when PUT sends null", async () => {
    await handleSessionsSettings(
      makePut({ sessionKey: "main", permissionMode: "guarded" }),
      new MockRes() as any,
    );
    const clearRes = new MockRes();
    await handleSessionsSettings(
      makePut({ sessionKey: "main", permissionMode: null }),
      clearRes as any,
    );
    expect(clearRes.statusCode).toBe(200);
    expect(JSON.parse(clearRes.body).permissionMode).toBeUndefined();
  });

  it("rejects an illegal permissionMode", async () => {
    const res = new MockRes();
    await handleSessionsSettings(
      makePut({ sessionKey: "main", permissionMode: "unrestricted" }),
      res as any,
    );
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/permissionMode must be one of/);
  });

  it("leaves permissionMode unchanged when the PUT body omits it", async () => {
    await handleSessionsSettings(
      makePut({ sessionKey: "main", permissionMode: "guarded" }),
      new MockRes() as any,
    );
    const res = new MockRes();
    await handleSessionsSettings(makePut({ sessionKey: "main" }), res as any);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).permissionMode).toBe("guarded");
  });

  it("permission-only PUT does not pin a model override", async () => {
    const sessionsFile = join(baseDir, ".openclaw", "agents", "main", "sessions", "sessions.json");
    const putRes = new MockRes();
    await handleSessionsSettings(
      makePut({ sessionKey: "main", permissionMode: "guarded" }),
      putRes as any,
    );
    expect(putRes.statusCode).toBe(200);
    const stored = JSON.parse(readFileSync(sessionsFile, "utf-8"));
    expect(stored["agent:main:main"].permissionMode).toBe("guarded");
    expect(stored["agent:main:main"].modelRef).toBeUndefined();
    expect(stored["agent:main:main"].modelOverride).toBeUndefined();
  });
});
