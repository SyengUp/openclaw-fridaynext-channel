import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
});
