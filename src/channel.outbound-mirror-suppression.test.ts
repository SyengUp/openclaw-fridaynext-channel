import { describe, expect, it } from "vitest";
import { fridayNextChannelPlugin } from "./channel.js";

/**
 * friday-next is a transparent proxy: outbound attachments/text already reach the app
 * live via SSE (sendText/sendMedia/handleSend). OpenClaw core's generic outbound path
 * additionally mirrors message-tool sends into the *recipient's* session transcript
 * (model:"delivery-mirror"). For friday-next that recipient session falls back to
 * `agent:<agentId>:friday-next:direct:<deviceId>` — an orphan session unrelated to the
 * app's real conversation — producing a phantom session + a stray delivery-mirror message.
 *
 * The core consults `messaging.resolveOutboundSessionRoute` FIRST; returning `null`
 * short-circuits route resolution so no orphan session entry and no delivery-mirror are
 * created. This test pins that contract.
 */
describe("friday-next channel suppresses core delivery-mirror", () => {
  const messaging = (fridayNextChannelPlugin as { messaging?: Record<string, unknown> }).messaging;

  it("exposes resolveOutboundSessionRoute on the messaging adapter", () => {
    expect(typeof messaging?.resolveOutboundSessionRoute).toBe("function");
  });

  it("returns null for any outbound target so no mirror session is routed", async () => {
    const resolve = messaging?.resolveOutboundSessionRoute as (
      params: Record<string, unknown>,
    ) => unknown;
    const route = await resolve({
      cfg: {},
      agentId: "operator",
      channel: "friday-next",
      target: "9cd3d546-b230-40ab-b931-bb2e8305e38c",
      currentSessionKey: "agent:operator:friday-next:9cd3d546",
    });
    expect(route).toBeNull();
  });
});
