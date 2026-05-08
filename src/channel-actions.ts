type MessageActionCtx = {
  action: string;
  params: Record<string, unknown>;
};

const DISCOVERY = {
  actions: ["send", "channel-info", "channel-list"] as const,
  capabilities: ["text", "media"] as const,
};

const CHANNEL_INFO_RESPONSE = {
  ok: true as const,
  channels: [{ id: "friday-next", name: "Friday Next", transport: "http+sse" }],
};

export function describeMessageActions() {
  return DISCOVERY;
}

export function handleMessageAction(ctx: MessageActionCtx): unknown {
  if (ctx.action === "channel-info" || ctx.action === "channel-list") {
    return CHANNEL_INFO_RESPONSE;
  }
  return null;
}
