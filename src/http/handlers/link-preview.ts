import type { IncomingMessage, ServerResponse } from "node:http";
import { createLinkPreviewHandler } from "@syengup/fridaynext-channel-kit/transport/link-preview";
import { getLinkPreviewService } from "../../link-preview/preview-service.js";
import { extractBearerToken } from "../middleware/auth.js";
export const handleLinkPreview = (req: IncomingMessage, res: ServerResponse) =>
  createLinkPreviewHandler({
    authenticate: (request) => extractBearerToken(request) !== null,
    preview: getLinkPreviewService(),
  }).handleLinkPreview(req, res);
