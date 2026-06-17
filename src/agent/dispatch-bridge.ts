// Returns a value or a thenable; `unknown` covers both (callers `await` the result).
type DispatchFn = (args: unknown) => unknown;

let overrideDispatch: DispatchFn | null = null;

export function runFridayDispatch(args: Parameters<DispatchFn>[0]): ReturnType<DispatchFn> {
  if (overrideDispatch) return overrideDispatch(args);
  return import("openclaw/plugin-sdk/reply-dispatch-runtime").then((m) =>
    m.dispatchReplyWithDispatcher(args as never),
  );
}

export function __setMockFridayDispatchForTests(fn: DispatchFn): void {
  overrideDispatch = fn;
}

export function __resetMockFridayDispatchForTests(): void {
  overrideDispatch = null;
}
