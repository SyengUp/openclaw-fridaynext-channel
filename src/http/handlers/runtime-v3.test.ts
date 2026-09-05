import { EventEmitter } from "node:events";
import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import {
  __resetMockFridayDispatchForTests,
  __setMockFridayDispatchForTests,
} from "../../agent/dispatch-bridge.js";
import { __setDetachedWebhookWorkImporterForTests } from "../../agent/detached-webhook-work.js";
import { clearFridayNextRuntime, setFridayNextRuntime } from "../../runtime.js";
import { getRuntimeV3Store, setRuntimeV3RootForTest } from "../../runtime-v3/runtime-store.js";
import { handleMessages } from "./messages.js";
import {
  handleRuntimeV3Acknowledge,
  handleRuntimeV3SessionSnapshot,
  handleRuntimeV3Sync,
} from "./runtime-v3.js";
import { sseEmitter } from "../../sse/emitter.js";
import { restoreDurableRuntimeV3 } from "../../runtime-v3/runtime-recovery.js";
import {
  resetFridayAgentForwardRuntimeForTest,
  setFridayAgentForwardRuntime,
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
    this.emit("finish");
  }
}

const roots: string[] = [];

function configure(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "friday-runtime-handler-"));
  roots.push(root);
  setFridayNextRuntime({
    config: {
      loadConfig: () => ({
        gateway: { auth: { token: "tok" } },
        channels: { "friday-next": { historyDir: root } },
      }),
    },
  } as never);
  setRuntimeV3RootForTest(path.join(root, "runtime-v3"));
  __setDetachedWebhookWorkImporterForTests(async () => ({
    runDetachedWebhookWork: async (run) => await run(),
  }));
  return root;
}

async function postMessage(body: Record<string, unknown>): Promise<MockRes> {
  const req = new PassThrough() as unknown as IncomingMessage;
  req.method = "POST";
  req.url = "/friday-next/v3/messages";
  req.headers = { authorization: "Bearer tok" };
  const response = new MockRes();
  const handled = handleMessages(req, response as unknown as ServerResponse);
  req.end(JSON.stringify(body));
  await handled;
  return response;
}

function postJSONRequest(url: string, body: Record<string, unknown>): IncomingMessage {
  const req = new PassThrough() as unknown as IncomingMessage;
  req.method = "POST";
  req.url = url;
  req.headers = { authorization: "Bearer tok" };
  queueMicrotask(() => (req as unknown as PassThrough).end(JSON.stringify(body)));
  return req;
}

afterEach(() => {
  __resetMockFridayDispatchForTests();
  __setDetachedWebhookWorkImporterForTests(null);
  setRuntimeV3RootForTest(null);
  resetFridayAgentForwardRuntimeForTest();
  clearFridayNextRuntime();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("runtime protocol v3", () => {
  it("returns a reconstructable session snapshot with transcript, segments and stable revision", async () => {
    const root = configure();
    const sessionKey = "agent:main:snapshot";
    const transcriptFile = path.join(root, "snapshot.jsonl");
    fs.writeFileSync(
      transcriptFile,
      [
        { type: "session", sessionId: "snapshot-session" },
        {
          type: "message",
          id: "user-entry",
          timestamp: "2026-09-05T00:00:00.000Z",
          message: { role: "user", content: "hello" },
        },
        {
          type: "message",
          id: "assistant-entry",
          timestamp: "2026-09-05T00:00:01.000Z",
          message: { role: "assistant", content: [{ type: "text", text: "world" }] },
        },
      ].map((line) => JSON.stringify(line)).join("\n") + "\n",
      "utf8",
    );
    setFridayAgentForwardRuntime({
      runtime: {
        agent: {
          session: {
            resolveStorePath: () => path.join(root, "sessions.json"),
            loadSessionStore: () => ({
              [sessionKey]: { sessionId: "snapshot-session", sessionFile: transcriptFile },
            }),
          },
        },
        config: { current: () => ({}) },
      },
    } as never);
    const store = getRuntimeV3Store();
    const run = store.acceptCommand({
      clientRequestId: "snapshot-request",
      deviceId: "PHONE-1",
      sessionKey,
      agentId: "main",
      text: "hello",
      attachments: [],
    }).run!;
    store.appendRunEvent(run.runId, "run.started", {});
    store.appendRunEvent(run.runId, "assistant.delta", { text: "world" });

    const request = {
      method: "GET",
      url: `/friday-next/v3/sessions/${encodeURIComponent(sessionKey)}/snapshot`,
      headers: { authorization: "Bearer tok" },
    } as IncomingMessage;
    const firstResponse = new MockRes();
    await handleRuntimeV3SessionSnapshot(
      request,
      firstResponse as unknown as ServerResponse,
      sessionKey,
    );
    const first = JSON.parse(firstResponse.body) as {
      revision: string;
      transcript: Array<{ id: string; role: string; text?: string }>;
      segments: Array<{ eventType: string }>;
      runs: Array<{ runId: string }>;
    };

    expect(firstResponse.statusCode).toBe(200);
    expect(first.transcript.map((message) => [message.id, message.role, message.text])).toEqual([
      ["user-entry", "user", "hello"],
      ["assistant-entry", "assistant", "world"],
    ]);
    expect(first.segments.map((event) => event.eventType)).toEqual([
      "run.started",
      "assistant.delta",
    ]);
    expect(first.runs.map((item) => item.runId)).toEqual([run.runId]);
    expect(first.revision).toMatch(/^[a-f0-9]{64}$/);

    const secondResponse = new MockRes();
    await handleRuntimeV3SessionSnapshot(
      request,
      secondResponse as unknown as ServerResponse,
      sessionKey,
    );
    expect(JSON.parse(secondResponse.body).revision).toBe(first.revision);
  });

  it("resumes a queued command after reconstructing the plugin runtime", async () => {
    const root = configure();
    let dispatchCount = 0;
    __setMockFridayDispatchForTests(async () => {
      dispatchCount += 1;
    });
    const firstStore = getRuntimeV3Store();
    const accepted = firstStore.acceptCommand({
      clientRequestId: "accepted-before-crash",
      deviceId: "PHONE-1",
      sessionKey: "agent:main:recover",
      agentId: "main",
      text: "resume me",
      attachments: [],
    }).run!;

    setRuntimeV3RootForTest(path.join(root, "runtime-v3"));
    const outcome = await restoreDurableRuntimeV3();
    await new Promise<void>((resolve) => setTimeout(resolve, 30));

    expect(outcome).toEqual({ restoredRouteCount: 1, resumedQueuedCount: 1 });
    expect(dispatchCount).toBe(1);
    expect(getRuntimeV3Store().run(accepted.runId)?.phase).toBe("completed");
  });

  it("writes an explicit terminal event for an interrupted run that cannot resume", async () => {
    const root = configure();
    const store = getRuntimeV3Store();
    const accepted = store.acceptCommand({
      clientRequestId: "running-before-crash",
      deviceId: "PHONE-1",
      sessionKey: "agent:main:interrupted",
      agentId: "main",
      text: "long task",
      attachments: [],
    }).run!;
    store.transition(accepted.runId, "running");

    setRuntimeV3RootForTest(path.join(root, "runtime-v3"));
    await restoreDurableRuntimeV3({
      isRunActive: async () => false,
      transcriptProvesCompletion: () => false,
    });

    const recovered = getRuntimeV3Store();
    expect(recovered.run(accepted.runId)?.phase).toBe("failed");
    expect(recovered.eventsAfter("PHONE-1", 0).at(-1)?.eventType).toBe("run.failed");
  });

  it("uses transcript evidence to close an interrupted run as completed", async () => {
    const root = configure();
    const store = getRuntimeV3Store();
    const accepted = store.acceptCommand({
      clientRequestId: "completed-before-crash",
      deviceId: "PHONE-1",
      sessionKey: "agent:main:completed",
      agentId: "main",
      text: "finish task",
      attachments: [],
    }).run!;
    store.transition(accepted.runId, "running");

    setRuntimeV3RootForTest(path.join(root, "runtime-v3"));
    await restoreDurableRuntimeV3({
      isRunActive: async () => false,
      transcriptProvesCompletion: () => true,
    });

    expect(getRuntimeV3Store().run(accepted.runId)?.phase).toBe("completed");
  });

  it("returns the original run for duplicate clientRequestId and rejects changed payloads", async () => {
    configure();
    let dispatchCount = 0;
    __setMockFridayDispatchForTests(async () => {
      dispatchCount += 1;
    });
    const command = {
      deviceId: "phone-1",
      clientRequestId: "client-message-1",
      text: "hello",
      sessionKey: "agent:main:one",
    };

    const first = await postMessage(command);
    const replay = await postMessage(command);
    const conflict = await postMessage({ ...command, text: "changed" });
    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    const firstBody = JSON.parse(first.body) as Record<string, unknown>;
    const replayBody = JSON.parse(replay.body) as Record<string, unknown>;
    expect(first.statusCode).toBe(202);
    expect(replay.statusCode).toBe(202);
    expect(replayBody.replayed).toBe(true);
    expect(replayBody.runId).toBe(firstBody.runId);
    expect(conflict.statusCode).toBe(409);
    expect(dispatchCount).toBe(1);
  });

  it("syncs durable events and advances acknowledgement monotonically", async () => {
    configure();
    const store = getRuntimeV3Store();
    const run = store.acceptCommand({
      clientRequestId: "request-1",
      deviceId: "PHONE-1",
      sessionKey: "agent:main:one",
      agentId: "main",
      text: "hello",
      attachments: [],
    }).run!;
    store.appendRunEvent(run.runId, "run.started", {});
    store.appendRunEvent(run.runId, "assistant.delta", { text: "hello" });

    const syncReq = {
      method: "GET",
      url: "/friday-next/v3/sync?deviceId=phone-1&afterEventId=0",
      headers: { authorization: "Bearer tok" },
    } as IncomingMessage;
    const syncRes = new MockRes();
    await handleRuntimeV3Sync(syncReq, syncRes as unknown as ServerResponse);
    const sync = JSON.parse(syncRes.body) as { events: unknown[]; headEventId: number };
    expect(sync.events).toHaveLength(2);
    expect(sync.headEventId).toBe(2);

    const ackRes = new MockRes();
    await handleRuntimeV3Acknowledge(
      postJSONRequest("/friday-next/v3/events/ack", {
        deviceId: "phone-1",
        serverInstanceId: store.serverInstanceId,
        throughEventId: 2,
      }),
      ackRes as unknown as ServerResponse,
    );
    expect(JSON.parse(ackRes.body)).toMatchObject({ ok: true, acknowledgedEventId: 2 });
  });

  it("mirrors existing agent, tool and subagent SSE frames into the durable run journal", () => {
    configure();
    const store = getRuntimeV3Store();
    const run = store.acceptCommand({
      clientRequestId: "request-mirror",
      deviceId: "PHONE-1",
      sessionKey: "agent:main:one",
      agentId: "main",
      text: "hello",
      attachments: [],
    }).run!;
    sseEmitter.trackDeviceForRun(run.deviceId, run.runId);

    sseEmitter.broadcastToRun(run.runId, {
      type: "agent",
      data: {
        deviceId: run.deviceId,
        sessionKey: run.sessionKey,
        runId: run.runId,
        stream: "thinking",
        data: { phase: "delta", text: "plan" },
      },
    });
    sseEmitter.broadcastToolEvent(run.deviceId, run.runId, {
      type: "tool-hook",
      data: { runId: run.runId, phase: "start", toolName: "exec" },
    });
    sseEmitter.broadcastToRun(run.runId, {
      type: "subagent",
      data: { runId: run.runId, phase: "spawned", label: "research" },
    });

    expect(store.eventsAfter(run.deviceId, 0).map((event) => event.eventType)).toEqual([
      "agent.thinking.delta",
      "tool.start",
      "subagent.spawned",
    ]);
    expect(store.eventsAfter(run.deviceId, 0)[0]?.payload).toMatchObject({
      _sourceEventType: "agent",
      _sourceEventData: { runId: run.runId, sessionKey: run.sessionKey },
    });
  });
});
