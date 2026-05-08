export function describeMessageActions() {
  return {
    actions: ["send", "channel-info", "channel-list"] as const,
    capabilities: ["text", "media"] as const,
  };
}

export async function handleMessageAction(ctx: {
  channel: string;
  action: string;
  params: Record<string, unknown>;
  mediaAccess?: unknown;
  mediaLocalRoots?: readonly string[];
  mediaReadFile?: (filePath: string) => Promise<Buffer>;
  accountId?: string | null;
  requesterSenderId?: string | null;
  sessionKey?: string | null;
  agentId?: string | null;
  dryRun?: boolean;
}): Promise<unknown> {
  const { action, params } = ctx;

  if (action === "channel-info" || action === "channel-list") {
    return {
      ok: true,
      channels: [
        {
          id: "friday-next",
          name: "Friday Next",
          transport: "http+sse",
        },
      ],
    };
  }

  // For "send", return null so the core sendMessage path handles it.
  // This falls through to deliverOutboundPayloads → createChannelHandler
  // which resolves the outbound adapter from the plugin registry.
  if (action === "send") {
    return null;
  }

  return null;
}
