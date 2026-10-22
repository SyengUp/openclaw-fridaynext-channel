import type { IncomingMessage, ServerResponse } from "node:http";
import { getOpenClawChannelService } from "../../adapters/openclaw/channel-service.js";
export const handleRuntimeV3Events = (req: IncomingMessage, res: ServerResponse) =>
  getOpenClawChannelService().runtimeTransport(req).handleRuntimeV3Events(req, res);
export const handleRuntimeV3Acknowledge = (req: IncomingMessage, res: ServerResponse) =>
  getOpenClawChannelService().runtimeTransport(req).handleRuntimeV3Acknowledge(req, res);
export const handleRuntimeV3Sync = (req: IncomingMessage, res: ServerResponse) =>
  getOpenClawChannelService().runtimeTransport(req).handleRuntimeV3Sync(req, res);
export const handleRuntimeV3SessionSnapshot = (
  req: IncomingMessage,
  res: ServerResponse,
  key: string,
  attempt = 0,
) =>
  getOpenClawChannelService()
    .runtimeTransport(req)
    .handleRuntimeV3SessionSnapshot(req, res, key, attempt);
export const handleRuntimeV3Cancel = (req: IncomingMessage, res: ServerResponse, runId: string) =>
  getOpenClawChannelService().runtimeTransport(req).handleRuntimeV3Cancel(req, res, runId);
