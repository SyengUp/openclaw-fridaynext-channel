import path from "node:path";
import { resolveFridayNextConfig } from "../config.js";
import { getHostOpenClawConfigSnapshot } from "../host-config.js";
import { getFridayNextRuntime } from "../runtime.js";
import { DurableRunStore } from "./durable-run-store.js";

/**
 * The live v3 store is process-global, not module-local.
 *
 * On OpenClaw 2026.9.5+ an external plugin can be loaded as MORE THAN ONE module
 * instance in the same process/realm (the gateway registers the plugin for its HTTP
 * routes, while tool resolution loads it through the generation capture). Module-level
 * singletons then diverge: the v3 SSE handler (route instance) registers its device
 * listeners on one store, and a device tool (tool instance) reads a different, empty
 * one — so `fridaynext_*` device tools report "iPhone not connected over SSE" even
 * while the app is connected. Keying the store on `globalThis` makes every instance
 * share the same store, listeners, pending requests, and delivery journal.
 */
const STORE_KEY = Symbol.for("@syengup/friday-channel-next/runtime-v3-store");
const ROOT_KEY = Symbol.for("@syengup/friday-channel-next/runtime-v3-root");
const OVERRIDE_ROOT_KEY = Symbol.for("@syengup/friday-channel-next/runtime-v3-override-root");

function readGlobal<T>(key: symbol): T | undefined {
  return Reflect.get(globalThis, key) as T | undefined;
}

export function resolveRuntimeV3Root(): string {
  const override = readGlobal<string | null>(OVERRIDE_ROOT_KEY);
  if (override) return override;
  const config = resolveFridayNextConfig(
    getHostOpenClawConfigSnapshot(getFridayNextRuntime().config),
  );
  return path.join(path.dirname(config.historyDir), "runtime-v3");
}

export function getRuntimeV3Store(): DurableRunStore {
  const root = resolveRuntimeV3Root();
  const existing = readGlobal<DurableRunStore>(STORE_KEY);
  if (existing && readGlobal<string | null>(ROOT_KEY) === root) {
    return existing;
  }
  const created = new DurableRunStore(root);
  Reflect.set(globalThis, STORE_KEY, created);
  Reflect.set(globalThis, ROOT_KEY, root);
  return created;
}

/** Returns the live v3 store without creating one for legacy-only traffic. */
export function runtimeV3StoreIfInitialized(): DurableRunStore | null {
  return readGlobal<DurableRunStore>(STORE_KEY) ?? null;
}

export function setRuntimeV3RootForTest(root: string | null): void {
  Reflect.set(globalThis, OVERRIDE_ROOT_KEY, root);
  Reflect.set(globalThis, ROOT_KEY, null);
  Reflect.set(globalThis, STORE_KEY, null);
}
