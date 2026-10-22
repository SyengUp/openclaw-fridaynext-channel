import os from "node:os";
import path from "node:path";
import { resolveFridayNextConfig } from "../../config.js";
import { getHostOpenClawConfigSnapshot } from "../../host-config.js";
import { getFridayNextRuntime } from "../../runtime.js";
import { processMap } from "../../process-state.js";

// 宿主配置与原有目录只在 OpenClaw 边界解析，公共库始终接收显式配置。
export function resolvePluginDataRoot(): string {
  try {
    return path.dirname(resolveFridayNextConfig(getHostOpenClawConfigSnapshot(getFridayNextRuntime().config)).historyDir);
  } catch {
    return path.join(os.homedir(), ".openclaw", "friday-next");
  }
}

export function sharedAdapterService<T>(name: string, identity: string, create: () => T): T {
  const values = processMap<string, T>(Symbol.for(`@syengup/friday-channel-next/adapter/${name}`));
  const existing = values.get(identity);
  if (existing !== undefined) return existing;
  const value = create();
  values.set(identity, value);
  return value;
}
