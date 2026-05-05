import { __setMockFridayDispatchForTests, __resetMockFridayDispatchForTests } from "../agent/dispatch-bridge.js";
import { forwardAgentEventRaw } from "../friday-session.js";

type DispatchArg = Parameters<typeof __setMockFridayDispatchForTests>[0] extends (arg: infer A) => unknown
  ? A
  : never;

type DispatchCallbacks = NonNullable<DispatchArg["dispatcherOptions"]>;

type ScriptStep = (args: DispatchArg, callbacks: DispatchCallbacks) => Promise<void> | void;

function runIdFromArgs(args: DispatchArg): string {
  return (args as { replyOptions?: { runId?: string } })?.replyOptions?.runId ?? "mock-run";
}

function sessionKeyFromArgs(args: DispatchArg): string {
  return (args as { ctx?: { SessionKey?: string } })?.ctx?.SessionKey ?? "";
}

export class MockDispatchScript {
  private readonly steps: ScriptStep[] = [];

  lifecycle(phase: "start" | "end" | "error"): this {
    this.steps.push((args, _callbacks) => {
      const runId = runIdFromArgs(args);
      const sessionKey = sessionKeyFromArgs(args);
      forwardAgentEventRaw({
        runId,
        seq: 1,
        ts: Date.now(),
        stream: "lifecycle",
        data: { phase },
        sessionKey,
      });
    });
    return this;
  }

  reasoning(text: string): this {
    this.steps.push((args, _callbacks) => {
      const runId = runIdFromArgs(args);
      const sessionKey = sessionKeyFromArgs(args);
      forwardAgentEventRaw({
        runId,
        seq: 1,
        ts: Date.now(),
        stream: "thinking",
        data: { phase: "delta", text },
        sessionKey,
      });
    });
    return this;
  }

  reasoningEnd(): this {
    return this;
  }

  partial(text: string): this {
    this.steps.push((args, _callbacks) => {
      const runId = runIdFromArgs(args);
      const sessionKey = sessionKeyFromArgs(args);
      forwardAgentEventRaw({
        runId,
        seq: 1,
        ts: Date.now(),
        stream: "assistant",
        data: { phase: "delta", text },
        sessionKey,
      });
    });
    return this;
  }

  toolStart(
    name: string,
    toolArgs: unknown,
    options?: { meta?: string; displayEmoji?: string; displayLabel?: string },
  ): this {
    this.steps.push((dispatchArgs, _callbacks) => {
      const runId = runIdFromArgs(dispatchArgs);
      const sessionKey = sessionKeyFromArgs(dispatchArgs);
      forwardAgentEventRaw({
        runId,
        seq: 1,
        ts: Date.now(),
        stream: "tool",
        data: {
          phase: "start",
          name,
          args: toolArgs,
          ...(options?.meta ? { meta: options.meta } : {}),
          ...(options?.displayEmoji ? { displayEmoji: options.displayEmoji } : {}),
          ...(options?.displayLabel ? { displayLabel: options.displayLabel } : {}),
        },
        sessionKey,
      });
    });
    return this;
  }

  toolEnd(name: string, result: unknown): this {
    this.steps.push((args, _callbacks) => {
      const runId = runIdFromArgs(args);
      const sessionKey = sessionKeyFromArgs(args);
      forwardAgentEventRaw({
        runId,
        seq: 1,
        ts: Date.now(),
        stream: "tool",
        data: { phase: "end", name, result },
        sessionKey,
      });
    });
    return this;
  }

  toolError(name: string, error: unknown): this {
    this.steps.push((args, _callbacks) => {
      const runId = runIdFromArgs(args);
      const sessionKey = sessionKeyFromArgs(args);
      forwardAgentEventRaw({
        runId,
        seq: 1,
        ts: Date.now(),
        stream: "tool",
        data: { phase: "error", name, error },
        sessionKey,
      });
    });
    return this;
  }

  block(text: string, mediaUrls: string[] = [], audioAsVoice = false): this {
    this.steps.push(async (_args, callbacks) => {
      await callbacks.deliver?.({ text, mediaUrls, audioAsVoice } as never, { kind: "block" } as never);
    });
    return this;
  }

  deliverFinal(payload: { text: string; mediaUrls?: string[]; audioAsVoice?: boolean; isError?: boolean }): this {
    this.steps.push(async (_args, callbacks) => {
      await callbacks.deliver?.(payload as never, { kind: "final" } as never);
    });
    return this;
  }

  throwError(error: string): this {
    this.steps.push((_args, callbacks) => {
      callbacks.onError?.(new Error(error));
    });
    return this;
  }

  complete(): this {
    return this;
  }

  install(): { restore: () => void; calls: DispatchArg[] } {
    const calls: DispatchArg[] = [];
    __setMockFridayDispatchForTests(async (args) => {
      calls.push(args as DispatchArg);
      const callbacks = (args.dispatcherOptions ?? {}) as DispatchCallbacks;
      for (const step of this.steps) {
        await step(args as DispatchArg, callbacks);
      }
    });
    return {
      restore: () => __resetMockFridayDispatchForTests(),
      calls,
    };
  }
}

export function mockDispatchScript(): MockDispatchScript {
  return new MockDispatchScript();
}

export function resetMockDispatch(): void {
  __resetMockFridayDispatchForTests();
}
