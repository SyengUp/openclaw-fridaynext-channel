import { describe, expect, it } from "vitest";
import { fridayNextChannelPlugin } from "./channel.js";

/**
 * friday-next is a passive HTTP+SSE channel whose routes live on the shared gateway server.
 * It still MUST keep its account lifecycle pending (running:true) so the core health-monitor
 * does not poll it as "stopped" and restart it every few minutes. A stopped account drops out
 * of the deliverable-channel registry, so an agent `message` send landing in that window fails
 * with `Unknown channel: friday-next`. See gateway.startAccount keep-alive in channel.ts.
 */
describe("friday-next channel gateway lifecycle", () => {
  it("exposes a startAccount keep-alive that stays pending until abort", async () => {
    const gateway = (fridayNextChannelPlugin as { gateway?: { startAccount?: unknown } }).gateway;
    expect(gateway?.startAccount).toBeTypeOf("function");

    const startAccount = gateway!.startAccount as (ctx: {
      accountId: string;
      abortSignal: AbortSignal;
    }) => Promise<unknown>;

    const controller = new AbortController();
    const started = startAccount({ accountId: "default", abortSignal: controller.signal });

    // Must stay pending while the account is alive (so the core keeps running:true).
    let settled = false;
    void started.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);

    // Aborting (reload / shutdown) resolves it cleanly.
    controller.abort();
    await expect(started).resolves.toBeUndefined();
  });
});
