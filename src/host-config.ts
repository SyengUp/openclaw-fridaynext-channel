type HostConfigLoader = {
  // Modern OpenClaw exposes config.current(); older builds only had config.loadConfig(),
  // which is now deprecated and logs a "runtime-config-load-write" warning on every call.
  current?: () => unknown;
  loadConfig?: () => unknown;
};

function asConfigLoader(value: unknown): HostConfigLoader | null {
  if (!value || typeof value !== "object") return null;
  const v = value as HostConfigLoader;
  if (typeof v.current === "function" || typeof v.loadConfig === "function") return v;
  return null;
}

export function getHostOpenClawConfigSnapshot(config: unknown): unknown {
  const loader = asConfigLoader(config);
  if (!loader) return {};
  try {
    // Prefer current() to avoid the deprecation warning; fall back to loadConfig() on old gateways.
    if (typeof loader.current === "function") return loader.current();
    return loader.loadConfig!();
  } catch {
    return {};
  }
}
