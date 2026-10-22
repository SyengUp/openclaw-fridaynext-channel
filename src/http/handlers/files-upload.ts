import type { IncomingMessage, ServerResponse } from "node:http";
import { createFileUploadHandler } from "@syengup/fridaynext-channel-kit/transport/files-upload";
import {getRuntimeV3Store} from "../../runtime-v3/runtime-store.js";
import { getAttachmentStore } from "./files.js";
import { extractBearerToken } from "../middleware/auth.js";
export { IdempotentUploadConflictError } from "@syengup/fridaynext-channel-kit/transport/files-upload";
function handler() { return createFileUploadHandler({files:getAttachmentStore(),authenticate:req=>extractBearerToken(req)!==null,serviceInstanceId:()=>getRuntimeV3Store().serverInstanceId}); }
export const storeIdempotentUpload = (...args: Parameters<ReturnType<typeof createFileUploadHandler>["storeIdempotentUpload"]>) => handler().storeIdempotentUpload(...args);
export const handleFilesUpload = (req:IncomingMessage,res:ServerResponse) => handler().handleFilesUpload(req,res);
