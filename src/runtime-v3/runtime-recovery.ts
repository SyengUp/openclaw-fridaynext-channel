import { getOpenClawChannelService } from "../adapters/openclaw/channel-service.js";
import { inspectOpenClawRun, type RuntimeRecoveryDeps } from "../adapters/openclaw/run-inspection.js";
export type { RuntimeRecoveryDeps } from "../adapters/openclaw/run-inspection.js";

// 保留旧调用入口；恢复状态机与排队重放只有 Kit 一份实现。
export function restoreDurableRuntimeV3(overrides?: Partial<RuntimeRecoveryDeps>) {
  return getOpenClawChannelService().restore(overrides ? run=>inspectOpenClawRun(run,overrides):undefined);
}
