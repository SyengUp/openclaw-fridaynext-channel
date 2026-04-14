import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";

const {
  setRuntime: setFridayRuntime,
  getRuntime: getFridayRuntime,
} = createPluginRuntimeStore<PluginRuntime>("Friday runtime not initialized");
export { getFridayRuntime, setFridayRuntime };
