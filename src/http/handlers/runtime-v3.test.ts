import { EventEmitter } from "node:events";
import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  handleRuntimeV3Events,
  handleRuntimeV3SessionSnapshot,
  handleRuntimeV3Sync,
} from "./runtime-v3.js";
import { sseEmitter } from "../../sse/emitter.js";
import { restoreDurableRuntimeV3 } from "../../runtime-v3/runtime-recovery.js";
import {
  resetFridayAgentForwardRuntimeForTest,
  setFridayAgentForwardRuntime,
} from "../../agent-forward-runtime.js";
import { observeAgentEventForActiveRuns, resetActiveRunsForTest } from "../../agent/active-runs.js";

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

class BackpressuredRes extends EventEmitter {
  statusCode = 0;
  writes: string[] = [];
  private blocked = false;
  private writeCount = 0;
  setHeader(): void {}
  flushHeaders(): void {}
  write(chunk: string): boolean {
    this.writes.push(chunk);
    this.writeCount += 1;
    if (this.writeCount === 2) this.blocked = true;
    return !this.blocked;
  }
  release(): void {
    this.blocked = false;
    this.emit("drain");
  }
  end(): void {
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
  sseEmitter.resetForTest();
  resetActiveRunsForTest();
  __resetMockFridayDispatchForTests();
  __setDetachedWebhookWorkImporterForTests(null);
  setRuntimeV3RootForTest(null);
  resetFridayAgentForwardRuntimeForTest();
  clearFridayNextRuntime();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("runtime protocol v3", () => {
  it("pauses durable replay while the response applies backpressure", async () => {
    configure();
    const store = getRuntimeV3Store();
    const run = store.acceptCommand({
      clientRequestId: "slow-replay",
      deviceId: "PHONE-1",
      sessionKey: "agent:main:slow-replay",
      agentId: "main",
      text: "hello",
      attachments: [],
    }).run!;
    store.appendRunEvent(run.runId, "run.started", {});
    store.appendRunEvent(run.runId, "assistant.delta", { text: "one" });
    store.appendRunEvent(run.runId, "assistant.delta", { text: "two" });
    const request = Object.assign(new EventEmitter(), {
      method: "GET",
      url: "/friday-next/v3/events?deviceId=PHONE-1",
      headers: { authorization: "Bearer tok" },
    }) as unknown as IncomingMessage;
    const response = new BackpressuredRes();

    await handleRuntimeV3Events(request, response as unknown as ServerResponse);

    expect(response.writes.filter((chunk) => chunk.includes("event: runtime"))).toHaveLength(1);
    response.release();
    expect(response.writes.filter((chunk) => chunk.includes("event: runtime"))).toHaveLength(3);
    request.emit("close");
  });

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
      ]
        .map((line) => JSON.stringify(line))
        .join("\n") + "\n",
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

  it("keeps a Friday command queued while another client is running the same session", async () => {
    configure();
    let dispatchCount = 0;
    __setMockFridayDispatchForTests(async () => {
      dispatchCount += 1;
    });
    const sessionKey = "agent:main:shared-session";
    observeAgentEventForActiveRuns({
      stream: "lifecycle",
      runId: "external-webchat-run",
      sessionKey,
      data: { phase: "start" },
    });

    const response = await postMessage({
      deviceId: "phone-1",
      clientRequestId: "queued-behind-external-run",
      text: "run after webchat",
      sessionKey,
    });
    const runId = String((JSON.parse(response.body) as Record<string, unknown>).runId);
    await new Promise<void>((resolve) => setTimeout(resolve, 30));

    expect(response.statusCode).toBe(202);
    expect(dispatchCount).toBe(0);
    expect(getRuntimeV3Store().run(runId)?.phase).toBe("queued");

    observeAgentEventForActiveRuns({
      stream: "lifecycle",
      runId: "external-webchat-run",
      sessionKey,
      data: { phase: "end" },
    });
    await vi.waitFor(() => expect(dispatchCount).toBe(1));
    expect(getRuntimeV3Store().run(runId)?.phase).toBe("completed");
  });

  it("serializes commands within one session through the detached dispatch boundary", async () => {
    configure();
    const dispatchedBodies: string[] = [];
    const releases: Array<() => void> = [];
    __setMockFridayDispatchForTests(async (args: unknown) => {
      const body = String((args as { ctx?: { Body?: unknown } }).ctx?.Body ?? "");
      dispatchedBodies.push(body);
      await new Promise<void>((resolve) => releases.push(resolve));
    });
    const base = {
      deviceId: "phone-1",
      sessionKey: "agent:main:serial-session",
    };

    await postMessage({ ...base, clientRequestId: "serial-1", text: "first" });
    await postMessage({ ...base, clientRequestId: "serial-2", text: "second" });
    await vi.waitFor(() => expect(dispatchedBodies).toEqual(["first"]));

    releases.shift()?.();
    await vi.waitFor(() => expect(dispatchedBodies).toEqual(["first", "second"]));
    releases.shift()?.();
    await vi.waitFor(() => {
      expect(getRuntimeV3Store().unfinishedRuns("phone-1")).toHaveLength(0);
    });
  });

  it("dispatches different sessions concurrently", async () => {
    configure();
    const dispatchedBodies: string[] = [];
    const releases: Array<() => void> = [];
    __setMockFridayDispatchForTests(async (args: unknown) => {
      const body = String((args as { ctx?: { Body?: unknown } }).ctx?.Body ?? "");
      dispatchedBodies.push(body);
      await new Promise<void>((resolve) => releases.push(resolve));
    });

    await postMessage({
      deviceId: "phone-1",
      clientRequestId: "parallel-1",
      text: "one",
      sessionKey: "agent:main:parallel-one",
    });
    await postMessage({
      deviceId: "phone-1",
      clientRequestId: "parallel-2",
      text: "two",
      sessionKey: "agent:main:parallel-two",
    });
    await vi.waitFor(() => expect(new Set(dispatchedBodies)).toEqual(new Set(["one", "two"])));

    for (const release of releases.splice(0)) release();
    await vi.waitFor(() => {
      expect(getRuntimeV3Store().unfinishedRuns("phone-1")).toHaveLength(0);
    });
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

  it("reports a compacted journal gap while the session snapshot retains every run segment", async () => {
    configure();
    const store = getRuntimeV3Store();
    const sessionKey = "agent:main:compacted";
    const run = store.acceptCommand({
      clientRequestId: "request-compacted",
      deviceId: "PHONE-1",
      sessionKey,
      agentId: "main",
      text: "hello",
      attachments: [],
    }).run!;
    store.appendRunEvent(run.runId, "run.started", {});
    store.appendRunEvent(run.runId, "assistant.delta", { text: "hello" });
    store.appendRunEvent(run.runId, "run.completed", {});
    store.acknowledge("PHONE-1", 3);

    const syncReq = {
      method: "GET",
      url: "/friday-next/v3/sync?deviceId=PHONE-1&afterEventId=0",
      headers: { authorization: "Bearer tok" },
    } as IncomingMessage;
    const syncRes = new MockRes();
    await handleRuntimeV3Sync(syncReq, syncRes as unknown as ServerResponse);
    expect(JSON.parse(syncRes.body)).toMatchObject({
      floorEventId: 4,
      headEventId: 3,
      gapDetected: true,
      hasMore: false,
      events: [],
    });

    const snapshotReq = {
      method: "GET",
      url: `/friday-next/v3/sessions/${encodeURIComponent(sessionKey)}/snapshot`,
      headers: { authorization: "Bearer tok" },
    } as IncomingMessage;
    const snapshotRes = new MockRes();
    await handleRuntimeV3SessionSnapshot(
      snapshotReq,
      snapshotRes as unknown as ServerResponse,
      sessionKey,
    );
    expect(
      (JSON.parse(snapshotRes.body) as { segments: Array<{ eventType: string }> }).segments.map(
        (event) => event.eventType,
      ),
    ).toEqual(["run.started", "assistant.delta", "run.completed"]);
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

  it("durably coalesces consecutive high-frequency deltas before a tool boundary", () => {
    configure();
    const store = getRuntimeV3Store();
    const run = store.acceptCommand({
      clientRequestId: "request-delta-batch",
      deviceId: "PHONE-1",
      sessionKey: "agent:main:delta-batch",
      agentId: "main",
      text: "hello",
      attachments: [],
    }).run!;
    sseEmitter.trackDeviceForRun(run.deviceId, run.runId);

    for (const text of ["first", "second"]) {
      sseEmitter.broadcastToRun(run.runId, {
        type: "agent",
        data: {
          deviceId: run.deviceId,
          sessionKey: run.sessionKey,
          runId: run.runId,
          stream: "assistant",
          data: { phase: "delta", text },
        },
      });
    }
    sseEmitter.broadcastToolEvent(run.deviceId, run.runId, {
      type: "tool-hook",
      data: { runId: run.runId, phase: "start", toolName: "exec" },
    });

    const events = store.eventsAfter(run.deviceId, 0);
    expect(events.map((event) => event.eventType)).toEqual(["agent.assistant.delta", "tool.start"]);
    expect(events[0]?.payload).toMatchObject({
      _sourceEventBatch: [
        { type: "agent", data: { data: { text: "first" } } },
        { type: "agent", data: { data: { text: "second" } } },
      ],
    });
  });
});
