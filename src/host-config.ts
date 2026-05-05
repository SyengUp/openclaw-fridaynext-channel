type HostConfigLoader = {
  loadConfig: () => unknown;
};

function isHostConfigLoader(value: unknown): value is HostConfigLoader {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as { loadConfig?: unknown }).loadConfig === "function"
  );
}

export function getHostOpenClawConfigSnapshot(config: unknown): unknown {
  if (!isHostConfigLoader(config)) return {};
  try {
    return config.loadConfig();
  } catch {
    return {};
  }
}
