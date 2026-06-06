import { createPluginRuntimeStore } from "./vendor/runtime-store.js";

type FridayRuntime = {
  // `current()` is the modern OpenClaw API; `loadConfig()` is the deprecated fallback
  // kept for older gateways.
  config: { current?: () => unknown; loadConfig?: () => unknown };
  logger?: { info?: (...args: unknown[]) => void; warn?: (...args: unknown[]) => void };
};

const { setRuntime, getRuntime, clearRuntime } = createPluginRuntimeStore<FridayRuntime>(
  "Friday Next runtime not initialized",
);

export const setFridayNextRuntime = setRuntime;
export const getFridayNextRuntime = getRuntime;
export const clearFridayNextRuntime = clearRuntime;
