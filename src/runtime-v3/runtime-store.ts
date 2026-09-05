import path from "node:path";
import { resolveFridayNextConfig } from "../config.js";
import { getHostOpenClawConfigSnapshot } from "../host-config.js";
import { getFridayNextRuntime } from "../runtime.js";
import { DurableRunStore } from "./durable-run-store.js";

let overrideRoot: string | null = null;
let activeRoot: string | null = null;
let activeStore: DurableRunStore | null = null;

export function resolveRuntimeV3Root(): string {
  if (overrideRoot) return overrideRoot;
  const config = resolveFridayNextConfig(
    getHostOpenClawConfigSnapshot(getFridayNextRuntime().config),
  );
  return path.join(path.dirname(config.historyDir), "runtime-v3");
}

export function getRuntimeV3Store(): DurableRunStore {
  const root = resolveRuntimeV3Root();
  if (!activeStore || activeRoot !== root) {
    activeRoot = root;
    activeStore = new DurableRunStore(root);
  }
  return activeStore;
}

/** Returns the live v3 store without creating one for legacy-only traffic. */
export function runtimeV3StoreIfInitialized(): DurableRunStore | null {
  return activeStore;
}

export function setRuntimeV3RootForTest(root: string | null): void {
  overrideRoot = root;
  activeRoot = null;
  activeStore = null;
}
