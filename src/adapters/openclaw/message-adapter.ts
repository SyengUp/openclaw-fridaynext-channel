import type { IncomingMessage, ServerResponse } from "node:http";
import { getOpenClawChannelService } from "./channel-service.js";

export const handleCanonicalMessages = (req: IncomingMessage, res: ServerResponse) =>
  getOpenClawChannelService().handle(req, res);
