/**
 * Process-global state shared across every module instance of this plugin.
 *
 * OpenClaw 2026.9.5+ can load an external plugin as MORE THAN ONE module instance in
 * the same process/realm: the gateway registers the plugin for its HTTP routes, while
 * tool resolution loads it through the generation capture. Module-level singletons then
 * diverge, so state that must be consistent across routes and tools has to live on
 * `globalThis` instead of a module-local variable.
 *
 * Keys are `Symbol.for(...)` so distinct module instances resolve the same slot.
 */

export function processMap<K, V>(key: symbol): Map<K, V> {
  const existing = Reflect.get(globalThis, key) as Map<K, V> | undefined;
  if (existing) return existing;
  const created = new Map<K, V>();
  Reflect.set(globalThis, key, created);
  return created;
}

export function processSet<V>(key: symbol): Set<V> {
  const existing = Reflect.get(globalThis, key) as Set<V> | undefined;
  if (existing) return existing;
  const created = new Set<V>();
  Reflect.set(globalThis, key, created);
  return created;
}

/** A process-global mutable scalar (for module-level `let`s that must be shared). */
export function processRef<T>(key: symbol, initial: T): { value: T } {
  const existing = Reflect.get(globalThis, key) as { value: T } | undefined;
  if (existing) return existing;
  const created = { value: initial };
  Reflect.set(globalThis, key, created);
  return created;
}
