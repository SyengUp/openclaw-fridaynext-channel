import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __setDetachedWebhookWorkImporterForTests,
  loadDetachedWebhookWork,
} from "./detached-webhook-work.js";

afterEach(() => {
  __setDetachedWebhookWorkImporterForTests(null);
});

describe("loadDetachedWebhookWork", () => {
  it("uses runDetachedWebhookWork when the host SDK exports it (OpenClaw 2026.8.1)", async () => {
    const spy = vi.fn(<T>(run: () => Promise<T>) => run());
    __setDetachedWebhookWorkImporterForTests(async () => ({ runDetachedWebhookWork: spy }));

    const start = await loadDetachedWebhookWork();
    await start(async () => 1);

    expect(spy).toHaveBeenCalledTimes(1);
  });

  // COMPAT(openclaw<2026.8.1): drop with detached-webhook-work.ts.
  it("falls back to identity when the subpath exists but the helper does not (OpenClaw 2026.6.11)", async () => {
    __setDetachedWebhookWorkImporterForTests(async () => ({
      // BJ 2026.6.11 webhook-request-guards: body-limit helpers only.
    }));

    const start = await loadDetachedWebhookWork();
    let ran = false;
    await start(async () => {
      ran = true;
    });

    expect(ran).toBe(true);
  });

  // COMPAT(openclaw<2026.8.1): drop with detached-webhook-work.ts.
  it("falls back to identity when the SDK subpath cannot be imported", async () => {
    __setDetachedWebhookWorkImporterForTests(async () => {
      throw Object.assign(new Error("Cannot find package"), { code: "ERR_MODULE_NOT_FOUND" });
    });

    const start = await loadDetachedWebhookWork();
    let ran = false;
    await start(async () => {
      ran = true;
    });

    expect(ran).toBe(true);
  });
});
