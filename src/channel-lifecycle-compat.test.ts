import { afterEach, describe, expect, it } from "vitest";
import {
  loadRunPassiveAccountLifecycle,
  __resetChannelLifecycleImporterForTest,
  __setChannelLifecycleImporterForTest,
} from "./channel-lifecycle-compat.js";

afterEach(() => {
  __resetChannelLifecycleImporterForTest();
});

describe("channel lifecycle 兼容加载", () => {
  it("优先使用 channel-outbound（2026.10.1 起 channel-lifecycle 已移除）", async () => {
    const modern = async () => undefined;
    const imported: string[] = [];
    __setChannelLifecycleImporterForTest(async (specifier) => {
      imported.push(specifier);
      return { runPassiveAccountLifecycle: modern };
    });

    const fn = await loadRunPassiveAccountLifecycle();
    expect(fn).toBe(modern);
    expect(imported).toEqual(["openclaw/plugin-sdk/channel-outbound"]);
  });

  it("新子路径不可用时回退 channel-lifecycle（旧宿主）", async () => {
    const legacy = async () => undefined;
    __setChannelLifecycleImporterForTest(async (specifier) => {
      if (specifier === "openclaw/plugin-sdk/channel-outbound") {
        const error = new Error("not exported") as Error & { code?: string };
        error.code = "ERR_PACKAGE_PATH_NOT_EXPORTED";
        throw error;
      }
      return { runPassiveAccountLifecycle: legacy };
    });

    expect(await loadRunPassiveAccountLifecycle()).toBe(legacy);
  });

  it("两个子路径都缺失时退回本地被动保持（start 后等待 abort）", async () => {
    __setChannelLifecycleImporterForTest(async () => {
      throw new Error("no such subpath");
    });

    const fn = await loadRunPassiveAccountLifecycle();
    expect(typeof fn).toBe("function");

    const controller = new AbortController();
    let started = false;
    let settled = false;
    const running = fn({
      abortSignal: controller.signal,
      start: async () => {
        started = true;
      },
    }).then(() => {
      settled = true;
    });

    await Promise.resolve();
    expect(started).toBe(true);
    expect(settled).toBe(false);

    controller.abort();
    await running;
    expect(settled).toBe(true);
  });

  it("缓存加载结果，重复调用不再 import", async () => {
    let calls = 0;
    const modern = async () => undefined;
    __setChannelLifecycleImporterForTest(async () => {
      calls += 1;
      return { runPassiveAccountLifecycle: modern };
    });

    await loadRunPassiveAccountLifecycle();
    await loadRunPassiveAccountLifecycle();
    expect(calls).toBe(1);
  });
});
