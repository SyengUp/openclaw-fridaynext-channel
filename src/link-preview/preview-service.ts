import { createLinkPreviewService } from "@syengup/fridaynext-channel-kit/link-preview/preview-service";
import { getAttachmentStore } from "../http/handlers/files.js";
import { sharedAdapterService } from "../adapters/openclaw/environment.js";
import { createFridayNextLogger } from "../logging.js";
export type * from "@syengup/fridaynext-channel-kit/link-preview/preview-service";
export function getLinkPreviewService() {
  const files = getAttachmentStore();
  return sharedAdapterService("link-preview", files.getAttachmentsDir(), () =>
    createLinkPreviewService({ files, logger: createFridayNextLogger("link-preview") }),
  );
}
export const getLinkPreview = (raw: string) => getLinkPreviewService().getLinkPreview(raw);
export const resetLinkPreviewCacheForTest = () =>
  getLinkPreviewService().resetLinkPreviewCacheForTest();
