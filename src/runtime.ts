import { createPluginRuntimeStore } from "./vendor/runtime-store.js";

type FridayRuntime = {
  // `current()` is the modern OpenClaw API; `loadConfig()` is the deprecated fallback
  // kept for older gateways.
  config: { current?: () => unknown; loadConfig?: () => unknown };
  logger?: { info?: (...args: unknown[]) => void; warn?: (...args: unknown[]) => void };
};

const { setRuntime, getRuntime, clearRuntime } = createPluginRuntimeStore<FridayRuntime>({
  // Explicit global registry key (NOT the string form): OpenClaw 2026.9.5+ loads an
  // external plugin as a second module instance for `tool-discovery`, which calls
  // `registerFull` WITHOUT `setRuntime`. Tools then execute in that instance and must
  // still read the runtime the full registration stored. A string key would create a
  // module-local slot and throw "Friday Next runtime not initialized" there.
  key: "@syengup/friday-channel-next/friday-runtime",
  errorMessage: "Friday Next runtime not initialized",
});

export const setFridayNextRuntime = setRuntime;
export const getFridayNextRuntime = getRuntime;
export const clearFridayNextRuntime = clearRuntime;
