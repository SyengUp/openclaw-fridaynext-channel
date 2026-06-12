import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { handleAgentFiles, CORE_AGENT_FILES } from "./agent-files.js";
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

function makeReq(headers: Record<string, string> = {}, method = "GET", body?: unknown): any {
  const stream = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  return Object.assign(stream, { method, url: "/friday-next/agents/main/files", headers });
}

function setWorkspace(workspace: string | undefined): void {
  setFridayAgentForwardRuntime({
    runtime: {
      agent: {
        session: { resolveStorePath: () => "", loadSessionStore: () => ({}) },
        ...(workspace ? { resolveAgentWorkspaceDir: () => workspace } : {}),
      },
      config: { current: () => ({}) },
    },
  } as any);
}

describe("handleAgentFiles", () => {
  let workspace: string;

  beforeEach(() => {
    setMockRuntime();
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "friday-files-"));
    setWorkspace(workspace);
  });

  afterEach(() => {
    resetFridayAgentForwardRuntimeForTest();
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it("rejects unsupported methods with 405", async () => {
    const res = new MockRes();
    await handleAgentFiles(makeReq(AUTH, "DELETE"), res as any, "main", undefined);
    expect(res.statusCode).toBe(405);
  });

  it("rejects missing token with 401", async () => {
    const res = new MockRes();
    await handleAgentFiles(makeReq({}, "GET"), res as any, "main", undefined);
    expect(res.statusCode).toBe(401);
  });

  it("503 when the workspace can't be resolved", async () => {
    setWorkspace(undefined);
    const res = new MockRes();
    await handleAgentFiles(makeReq(AUTH), res as any, "main", undefined);
    expect(res.statusCode).toBe(503);
  });

  it("GET lists every whitelist file with existence + size", async () => {
    fs.writeFileSync(path.join(workspace, "IDENTITY.md"), "hello");
    const res = new MockRes();
    await handleAgentFiles(makeReq(AUTH), res as any, "main", undefined);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.files).toHaveLength(CORE_AGENT_FILES.length);
    const identity = body.files.find((f: { name: string }) => f.name === "IDENTITY.md");
    expect(identity).toEqual({ name: "IDENTITY.md", exists: true, bytes: 5 });
    const soul = body.files.find((f: { name: string }) => f.name === "SOUL.md");
    expect(soul).toEqual({ name: "SOUL.md", exists: false, bytes: 0 });
  });

  it("GET one file returns its content", async () => {
    fs.writeFileSync(path.join(workspace, "AGENTS.md"), "# rules\n");
    const res = new MockRes();
    await handleAgentFiles(makeReq(AUTH), res as any, "main", "AGENTS.md");
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toMatchObject({ ok: true, name: "AGENTS.md", exists: true, content: "# rules\n" });
  });

  it("GET a missing whitelisted file returns exists:false with empty content", async () => {
    const res = new MockRes();
    await handleAgentFiles(makeReq(AUTH), res as any, "main", "MEMORY.md");
    const body = JSON.parse(res.body);
    expect(body).toMatchObject({ exists: false, content: "" });
  });

  it("rejects a non-whitelisted file name with 400", async () => {
    const res = new MockRes();
    await handleAgentFiles(makeReq(AUTH), res as any, "main", "secrets.env");
    expect(res.statusCode).toBe(400);
  });

  it("rejects path-traversal names with 400", async () => {
    const res = new MockRes();
    await handleAgentFiles(makeReq(AUTH), res as any, "main", "../escape.md");
    expect(res.statusCode).toBe(400);
  });

  it("PUT writes content and the file lands on disk", async () => {
    const res = new MockRes();
    await handleAgentFiles(
      makeReq(AUTH, "PUT", { content: "You are Friday." }),
      res as any,
      "main",
      "IDENTITY.md",
    );
    expect(res.statusCode).toBe(200);
    expect(fs.readFileSync(path.join(workspace, "IDENTITY.md"), "utf-8")).toBe("You are Friday.");
  });

  it("PUT without a content string returns 400", async () => {
    const res = new MockRes();
    await handleAgentFiles(makeReq(AUTH, "PUT", { foo: 1 }), res as any, "main", "IDENTITY.md");
    expect(res.statusCode).toBe(400);
  });
});
