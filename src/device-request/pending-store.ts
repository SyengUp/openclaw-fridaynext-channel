import {
  createDeviceRequestPendingStore,
  type DeviceRequestPendingStoreOptions,
  type DeviceRequestPendingStore,
} from "@syengup/fridaynext-channel-kit/device-request/pending-store";
import { processMap } from "../process-state.js";
export * from "@syengup/fridaynext-channel-kit/device-request/pending-store";

// 宿主双模块共享同一组工具等待器；等待、超时和完成机制只有 Kit 实现。
export function getProcessDeviceRequestPendingStore(
  key: string,
  options: DeviceRequestPendingStoreOptions,
): DeviceRequestPendingStore {
  const identity = key.trim();
  if (!identity) throw new Error("pending store key is required");
  const stores = processMap<string, DeviceRequestPendingStore>(
    Symbol.for("@syengup/friday-channel-next/device-request-pending-stores"),
  );
  let value = stores.get(identity);
  if (!value) {
    value = createDeviceRequestPendingStore(options);
    stores.set(identity, value);
  }
  return value;
}
