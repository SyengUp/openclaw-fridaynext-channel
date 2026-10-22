import type { IncomingMessage, ServerResponse } from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createFileDownloadHandler } from "@syengup/fridaynext-channel-kit/transport/files-download";
import { getAttachmentStore, guessMimeType } from "./files.js";
import { extractBearerToken } from "../middleware/auth.js";
import { createFridayNextLogger } from "../../logging.js";

// 旧宿主媒体目录的查找规则只保留在适配器，下载、Range 与响应头由公共库负责。
export function readHostMedia(token:string) {
  const dir=path.join(os.homedir(),".openclaw","media","inbound");
  for(const file of [path.join(dir,token.replace(/\.[^.]+$/,"")),path.join(dir,token)]) {
    try { if(fs.statSync(file).isFile()) return {buffer:fs.readFileSync(file),mimeType:guessMimeType(token),filename:token}; } catch { /* 宿主可选媒体目录不可用 */ }
  }
  return undefined;
}
export const handleFilesDownload = (req:IncomingMessage,res:ServerResponse) => createFileDownloadHandler({files:getAttachmentStore(),authenticate:request=>extractBearerToken(request)!==null,readHostMedia,logger:createFridayNextLogger("files-download")}).handleFilesDownload(req,res);
