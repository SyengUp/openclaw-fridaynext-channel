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

  it("derives account and channel lifecycle status from the core runtime", async () => {
    const status = (
      fridayNextChannelPlugin as {
        status?: {
          buildAccountSnapshot?: (params: unknown) => Promise<unknown> | unknown;
          buildChannelSummary?: (snapshot: unknown) => unknown;
        };
      }
    ).status;
    expect(status?.buildAccountSnapshot).toBeTypeOf("function");
    expect(status?.buildChannelSummary).toBeTypeOf("function");

    const stopped = (await status!.buildAccountSnapshot!({
      account: { accountId: "default", name: "Friday Next Channel", enabled: true },
      runtime: {
        accountId: "default",
        running: false,
        lastStartAt: 100,
        lastStopAt: 200,
        lastError: "provider stopped",
        lastInboundAt: 150,
      },
    })) as Record<string, unknown>;

    // Regression: the old adapter hard-coded running:true and hid real lifecycle failures.
    expect(stopped).toMatchObject({
      accountId: "default",
      configured: true,
      running: false,
      lastStartAt: 100,
      lastStopAt: 200,
      lastError: "provider stopped",
      connected: false,
      lastInboundAt: 150,
      mode: "http+sse",
    });

    const summary = status!.buildChannelSummary!({
      snapshot: {
        configured: true,
        running: true,
        lastStartAt: 300,
        lastStopAt: null,
        lastError: null,
      },
    }) as Record<string, unknown>;
    expect(summary).toMatchObject({
      configured: true,
      running: true,
      lastStartAt: 300,
      lastStopAt: null,
      lastError: null,
      mode: "http+sse",
    });
  });
});
