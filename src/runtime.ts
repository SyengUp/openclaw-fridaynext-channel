import { createPluginRuntimeStore } from "./vendor/runtime-store.js";

type FridayRuntime = {
  config: { loadConfig: () => unknown };
  logger?: { info?: (...args: unknown[]) => void; warn?: (...args: unknown[]) => void };
};

const { setRuntime, getRuntime, clearRuntime } = createPluginRuntimeStore<FridayRuntime>(
  "Friday Next runtime not initialized",
);

export const setFridayNextRuntime = setRuntime;
export const getFridayNextRuntime = getRuntime;
export const clearFridayNextRuntime = clearRuntime;
