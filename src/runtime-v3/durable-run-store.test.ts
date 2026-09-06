import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DurableRunStore, type DurableRunCommand } from "./durable-run-store.js";

const tempRoots: string[] = [];

function makeStore(): { root: string; store: DurableRunStore } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "friday-runtime-v3-"));
  tempRoots.push(root);
  return { root, store: new DurableRunStore(root) };
}

function command(overrides: Partial<DurableRunCommand> = {}): DurableRunCommand {
  return {
    clientRequestId: "request-1",
    deviceId: "PHONE-1",
    sessionKey: "agent:main:session-1",
    agentId: "main",
    text: "hello",
    attachments: [],
    ...overrides,
  };
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("DurableRunStore", () => {
  it("durably purges one deleted session without disturbing another session", () => {
    const { root, store } = makeStore();
    const deleted = store.acceptCommand(command()).run!;
    store.appendRunEvent(deleted.runId, "run.started", {});
    store.registerDeviceRequest({
      kind: "health",
      requestId: "health-deleted",
      deviceId: "PHONE-1",
      sessionKey: deleted.sessionKey,
      runId: deleted.runId,
      sourceEventType: "fridaynext-health-query",
      payload: { metrics: ["steps"] },
    });
    const kept = store.acceptCommand(
      command({
        clientRequestId: "request-kept",
        sessionKey: "agent:research:kept",
        agentId: "research",
      }),
    ).run!;
    store.appendRunEvent(kept.runId, "run.started", {});

    store.deleteSession("AGENT:MAIN:SESSION-1");

    expect(store.run(deleted.runId)).toBeUndefined();
    expect(store.eventsForSession(deleted.sessionKey)).toEqual([]);
    expect(store.pendingDeviceRequests("PHONE-1")).toEqual([]);
    expect(store.run(kept.runId)?.phase).toBe("running");
    expect(store.eventsForSession(kept.sessionKey)).toHaveLength(1);

    const reconstructed = new DurableRunStore(root);
    expect(reconstructed.run(deleted.runId)).toBeUndefined();
    expect(reconstructed.eventsForSession(deleted.sessionKey)).toEqual([]);
    expect(reconstructed.pendingDeviceRequests("PHONE-1")).toEqual([]);
    expect(reconstructed.run(kept.runId)?.phase).toBe("running");
    expect(reconstructed.acceptCommand(command())).toMatchObject({
      outcome: "deleted",
      deletedRunId: deleted.runId,
    });
    expect(
      reconstructed.acceptCommand(command({ clientRequestId: "request-after-delete" })),
    ).toMatchObject({ outcome: "accepted" });
  });

  it("idempotently replays the same accepted request after store reconstruction", () => {
    const { root, store } = makeStore();

    const accepted = store.acceptCommand(command());
    expect(accepted.outcome).toBe("accepted");
    expect(accepted.run).toMatchObject({
      clientRequestId: "request-1",
      deviceId: "PHONE-1",
      sessionKey: "agent:main:session-1",
      phase: "queued",
    });

    const reconstructed = new DurableRunStore(root);
    const replayed = reconstructed.acceptCommand(command());
    expect(replayed.outcome).toBe("replayed");
    expect(replayed.run?.runId).toBe(accepted.run?.runId);

    const conflict = reconstructed.acceptCommand(command({ text: "different" }));
    expect(conflict.outcome).toBe("conflict");
    expect(conflict.run?.runId).toBe(accepted.run?.runId);
  });

  it("treats absent and empty session options as the same request", () => {
    const { store } = makeStore();
    const accepted = store.acceptCommand(command());

    const replayed = store.acceptCommand(command({ sessionOptions: {} }));

    expect(replayed.outcome).toBe("replayed");
    expect(replayed.run?.runId).toBe(accepted.run?.runId);
  });

  it("claims one run per session while allowing different sessions in parallel", () => {
    const { store } = makeStore();
    const first = store.acceptCommand(command()).run!;
    const second = store.acceptCommand(
      command({ clientRequestId: "request-2", text: "second" }),
    ).run!;
    const otherSession = store.acceptCommand(
      command({
        clientRequestId: "request-3",
        sessionKey: "agent:research:session-2",
        agentId: "research",
        text: "parallel",
      }),
    ).run!;

    const claimed = store.claimRunnable();
    expect(claimed.map((run) => run.runId).sort()).toEqual(
      [first.runId, otherSession.runId].sort(),
    );
    expect(store.run(second.runId)?.phase).toBe("queued");

    store.transition(first.runId, "completed");
    expect(store.claimRunnable().map((run) => run.runId)).toEqual([second.runId]);
  });

  it("never grants the same dispatching run to a duplicate claimant", () => {
    const { store } = makeStore();
    const run = store.acceptCommand(command()).run!;

    expect(store.claimRun(run.runId)?.phase).toBe("dispatching");
    expect(store.claimRun(run.runId)).toBeUndefined();
  });

  it("persists ordered events and the committed device acknowledgement", () => {
    const { root, store } = makeStore();
    const run = store.acceptCommand(command()).run!;

    const started = store.appendRunEvent(run.runId, "run.started", { phase: "start" });
    const delta = store.appendRunEvent(run.runId, "assistant.delta", { text: "hi" });
    expect(started).toMatchObject({ eventId: 1, runSeq: 1, runId: run.runId });
    expect(delta).toMatchObject({ eventId: 2, runSeq: 2, runId: run.runId });

    store.acknowledge("phone-1", 2);

    const reconstructed = new DurableRunStore(root);
    expect(reconstructed.eventsAfter("PHONE-1", 0).map((event) => event.eventId)).toEqual([1, 2]);
    expect(reconstructed.acknowledgedEventId("PHONE-1")).toBe(2);
    expect(reconstructed.run(run.runId)?.lastRunSeq).toBe(2);
  });

  it("compacts acknowledged terminal delivery events without losing the process snapshot or event head", () => {
    const { root, store } = makeStore();
    const run = store.acceptCommand(command()).run!;
    store.appendRunEvent(run.runId, "run.started", {});
    store.appendRunEvent(run.runId, "assistant.delta", { text: "complete answer" });
    store.appendRunEvent(run.runId, "run.completed", {});

    store.acknowledge("PHONE-1", 3);

    expect(store.eventsAfter("PHONE-1", 0)).toEqual([]);
    const reconstructed = new DurableRunStore(root);
    expect(reconstructed.eventsForSession(run.sessionKey).map((event) => event.eventType)).toEqual([
      "run.started",
      "assistant.delta",
      "run.completed",
    ]);
    expect(reconstructed.eventHead("PHONE-1")).toBe(3);
    expect(reconstructed.eventFloor("PHONE-1")).toBe(4);

    const nextRun = reconstructed.acceptCommand(
      command({ clientRequestId: "request-2", sessionKey: "agent:main:session-2" }),
    ).run!;
    expect(reconstructed.appendRunEvent(nextRun.runId, "run.started", {}).eventId).toBe(4);
  });

  it("does not reopen every terminal snapshot for each acknowledgement", () => {
    const { root, store } = makeStore();
    const completed = store.acceptCommand(command()).run!;
    store.appendRunEvent(completed.runId, "run.completed", {});

    const reconstructed = new DurableRunStore(root);
    const active = reconstructed.acceptCommand(
      command({ clientRequestId: "request-active", sessionKey: "agent:main:active" }),
    ).run!;
    const activeEvent = reconstructed.appendRunEvent(active.runId, "run.started", {});
    const snapshotRead = vi.spyOn(
      reconstructed as unknown as { readRunSnapshot(runId: string): unknown },
      "readRunSnapshot",
    );

    reconstructed.acknowledge("PHONE-1", activeEvent.eventId);

    expect(snapshotRead).not.toHaveBeenCalled();
  });

  it("boots from durable terminal metadata without inflating archived process snapshots", () => {
    const { root, store } = makeStore();
    const completed = store.acceptCommand(command()).run!;
    store.appendRunEvent(completed.runId, "assistant.delta", { text: "complete answer" });
    store.appendRunEvent(completed.runId, "run.completed", {});
    store.acknowledge("PHONE-1", store.eventHead("PHONE-1"));

    const snapshotRead = vi.spyOn(
      DurableRunStore.prototype as unknown as { readRunSnapshot(runId: string): unknown },
      "readRunSnapshot",
    );
    const reconstructed = new DurableRunStore(root);

    expect(snapshotRead).not.toHaveBeenCalled();
    snapshotRead.mockRestore();
    expect(reconstructed.eventsForRun(completed.runId).map((event) => event.eventType)).toEqual([
      "assistant.delta",
      "run.completed",
    ]);
  });

  it("uses the durable delivery record to rebuild nonterminal run state without extra metadata flushes", () => {
    const { root, store } = makeStore();
    const run = store.acceptCommand(command()).run!;
    const persistHead = vi.spyOn(
      store as unknown as { persistEventHeads(): void },
      "persistEventHeads",
    );
    const persistRun = vi.spyOn(
      store as unknown as { persistRun(run: unknown): void },
      "persistRun",
    );

    const event = store.appendRunEvent(run.runId, "run.started", { text: "durable" });

    expect(persistHead).not.toHaveBeenCalled();
    expect(persistRun).not.toHaveBeenCalled();
    const reconstructed = new DurableRunStore(root);
    expect(reconstructed.eventHead("PHONE-1")).toBe(event.eventId);
    expect(reconstructed.run(run.runId)).toMatchObject({
      phase: "running",
      lastRunSeq: event.runSeq,
    });
  });

  it("rebuilds per-session indexes and restores process events from multiple devices", () => {
    const { root, store } = makeStore();
    for (let index = 0; index < 200; index += 1) {
      store.acceptCommand(
        command({
          clientRequestId: `unrelated-${index}`,
          sessionKey: `agent:main:unrelated-${index}`,
        }),
      );
    }
    const first = store.acceptCommand(
      command({ clientRequestId: "target-1", sessionKey: "agent:main:target" }),
    ).run!;
    store.appendRunEvent(first.runId, "run.completed", { device: "one" });
    const second = store.acceptCommand(
      command({
        clientRequestId: "target-2",
        deviceId: "PHONE-2",
        sessionKey: "agent:main:target",
      }),
    ).run!;
    store.appendRunEvent(second.runId, "run.completed", { device: "two" });
    store.acknowledge("PHONE-1", store.eventHead("PHONE-1"));
    store.acknowledge("PHONE-2", store.eventHead("PHONE-2"));

    const reconstructed = new DurableRunStore(root);

    expect(reconstructed.eventsForSession("agent:main:target").map((event) => event.runId)).toEqual(
      [first.runId, second.runId],
    );
    expect(reconstructed.activeRunForSession("agent:main:unrelated-199")?.runId).toBeUndefined();
  });

  it("repairs run phase and sequence when a crash lands the event before its run projection", () => {
    const { root, store } = makeStore();
    const run = store.acceptCommand(command()).run!;
    const deliveryName = crypto.createHash("sha256").update("PHONE-1").digest("hex");
    const deliveryFile = path.join(root, "delivery", `${deliveryName}.jsonl`);
    fs.appendFileSync(
      deliveryFile,
      `${JSON.stringify({
        protocolVersion: 3,
        serverInstanceId: store.serverInstanceId,
        eventId: 1,
        sessionKey: run.sessionKey,
        agentId: run.agentId,
        runId: run.runId,
        runSeq: 1,
        eventType: "run.completed",
        occurredAt: run.updatedAt + 1,
        payload: { simulatedCrashWindow: true },
      })}\n`,
    );

    const reconstructed = new DurableRunStore(root);
    expect(reconstructed.run(run.runId)).toMatchObject({
      phase: "completed",
      lastRunSeq: 1,
    });
    const terminal = reconstructed.appendRunEvent(run.runId, "audit.replayed", {});
    expect(terminal.runSeq).toBe(1);
    expect(reconstructed.eventsForRun(run.runId)).toHaveLength(1);
  });

  it("persists idempotent command receipts and rejects changed replay payloads", () => {
    const { root, store } = makeStore();
    const payload = { decision: "allow-once", deviceId: "PHONE-1" };

    expect(store.commandReceiptStatus("approval", "approval-1", payload)).toBe("missing");
    store.prepareCommandReceipt("approval", "approval-1", payload);
    store.completeCommandReceipt("approval", "approval-1", payload, {
      ok: true,
      approvalId: "approval-1",
    });

    const reconstructed = new DurableRunStore(root);
    expect(reconstructed.commandReceiptStatus("approval", "approval-1", payload)).toBe("replayed");
    expect(
      reconstructed.commandReceiptStatus("approval", "approval-1", {
        decision: "deny",
        deviceId: "PHONE-1",
      }),
    ).toBe("conflict");
    expect(reconstructed.commandReceipt("approval", "approval-1")?.response).toEqual({
      ok: true,
      approvalId: "approval-1",
    });
  });

  it("resolves the active run only inside the requested session and device", () => {
    const { store } = makeStore();
    const active = store.acceptCommand(command()).run!;
    const queued = store.acceptCommand(command({ clientRequestId: "request-2" })).run!;
    store.transition(active.runId, "running");

    expect(store.activeRunForSession("agent:main:session-1", "PHONE-1")?.runId).toBe(active.runId);
    expect(store.activeRunForSession("agent:main:session-1", "OTHER")).toBeUndefined();
    expect(store.activeRunForSession("agent:other:session-2", "PHONE-1")).toBeUndefined();
    expect(store.run(queued.runId)?.phase).toBe("queued");
  });

  it("projects persisted approval and device waits as explicit run phases", () => {
    const { store } = makeStore();
    const run = store.acceptCommand(command()).run!;
    store.appendRunEvent(run.runId, "run.started", {});

    store.appendRunEvent(run.runId, "approval.request", { approvalId: "a" });
    expect(store.run(run.runId)?.phase).toBe("waitingForApproval");
    store.appendRunEvent(run.runId, "approval.resolved", { approvalId: "a" });
    expect(store.run(run.runId)?.phase).toBe("running");
    store.appendRunEvent(run.runId, "device.health.request", { requestId: "h" });
    expect(store.run(run.runId)?.phase).toBe("waitingForDevice");
  });

  it("does not publish a second terminal event when lifecycle and dispatcher both close a run", () => {
    const { store } = makeStore();
    const run = store.acceptCommand(command()).run!;
    store.appendRunEvent(run.runId, "run.started", {});

    const lifecycleTerminal = store.appendRunEvent(run.runId, "run.completed", {
      source: "lifecycle.end",
    });
    const dispatcherTerminal = store.appendRunEvent(run.runId, "run.completed", {
      source: "dispatch.resolve",
    });

    expect(dispatcherTerminal.eventId).toBe(lifecycleTerminal.eventId);
    expect(store.run(run.runId)?.lastRunSeq).toBe(2);
    expect(
      store.eventsForRun(run.runId).filter((event) => event.eventType === "run.completed"),
    ).toHaveLength(1);
  });

  it("never appends a delayed replay frame after a run is terminal", () => {
    const { root, store } = makeStore();
    const run = store.acceptCommand(command()).run!;
    store.appendRunEvent(run.runId, "run.started", {});
    const terminal = store.appendRunEvent(run.runId, "run.completed", {});

    const delayed = store.appendRunEvent(run.runId, "agent.assistant.update", {
      _sourceEventType: "agent",
      _sourceEventData: {
        runId: run.runId,
        seq: 2,
        stream: "assistant",
        data: { text: "stale replay" },
      },
    });

    expect(delayed.eventId).toBe(terminal.eventId);
    expect(store.run(run.runId)?.lastRunSeq).toBe(2);
    expect(store.eventsForRun(run.runId).map((event) => event.eventType)).toEqual([
      "run.started",
      "run.completed",
    ]);

    const reconstructed = new DurableRunStore(root);
    expect(reconstructed.run(run.runId)?.phase).toBe("completed");
    expect(reconstructed.run(run.runId)?.lastRunSeq).toBe(2);
  });

  it("restores a pending device request and can complete it after reconstruction", () => {
    const { root, store } = makeStore();
    const run = store.acceptCommand(command()).run!;
    store.transition(run.runId, "running");
    store.registerDeviceRequest({
      kind: "health",
      requestId: "health-1",
      deviceId: "PHONE-1",
      sessionKey: run.sessionKey,
      runId: run.runId,
      sourceEventType: "fridaynext-health-query",
      payload: { metrics: ["steps"] },
    });

    const reconstructed = new DurableRunStore(root);
    expect(reconstructed.pendingDeviceRequests("PHONE-1")).toMatchObject([
      {
        kind: "health",
        requestId: "health-1",
        sessionKey: run.sessionKey,
        runId: run.runId,
        sourceEventType: "fridaynext-health-query",
        payload: { metrics: ["steps"] },
        state: "pending",
      },
    ]);

    reconstructed.completeDeviceRequest("health", "health-1");
    expect(new DurableRunStore(root).pendingDeviceRequests("PHONE-1")).toEqual([]);
  });

  it("appends a post-terminal session-title meta event without resurrecting the run", () => {
    const { root, store } = makeStore();
    const run = store.acceptCommand(command()).run!;
    store.appendRunEvent(run.runId, "run.started", {});
    store.appendRunEvent(run.runId, "run.completed", {});

    // The AI title is generated asynchronously and can land AFTER the run that
    // produced the first message already completed (fast reply + slow utility
    // model). The meta event must still be journaled so runtime-v3 clients
    // receive it live and on replay — the legacy SSE broadcast is invisible to
    // them.
    const title = store.appendRunEvent(run.runId, "session-title", {
      _sourceEventType: "session-title",
      _sourceEventData: {
        sessionKey: run.sessionKey,
        title: "长诗创作请求",
        deviceId: "PHONE-1",
        runId: run.runId,
        ts: 123,
      },
    });

    expect(title.eventType).toBe("session-title");
    expect(title.runId).toBe(run.runId);
    expect(store.run(run.runId)?.phase).toBe("completed");
    expect(store.eventsAfter("PHONE-1", 0).map((event) => event.eventType)).toEqual([
      "run.started",
      "run.completed",
      "session-title",
    ]);

    // Archive invariant: the snapshot rewritten for the terminal run must carry
    // the meta event, so acknowledged-journal compaction cannot silently lose it.
    const reconstructed = new DurableRunStore(root);
    expect(reconstructed.run(run.runId)?.phase).toBe("completed");
    expect(reconstructed.eventsForRun(run.runId).map((event) => event.eventType)).toContain(
      "session-title",
    );
  });
});
