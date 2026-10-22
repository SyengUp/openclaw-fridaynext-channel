import { fileURLToPath } from "node:url";
import path from 'node:path';
import os from 'node:os';
import { createAttachmentStore } from '@syengup/fridaynext-channel-kit/attachment/store';
import { resolvePluginDataRoot, sharedAdapterService } from '../../adapters/openclaw/environment.js';
import { createFridayNextLogger } from '../../logging.js';
export type * from '@syengup/fridaynext-channel-kit/attachment/store';
let override: string | null = null;
export function setAttachmentsDirForTest(value: string | null): void { override = value; }
export function normalizeAgentMediaPath(raw: string): string {
  const s = raw.trim();
  if (!s) return s;
  try {
    if (/^file:/i.test(s)) {
      return fileURLToPath(s);
    }
  } catch {
    // ignore malformed file URL
  }
  if (s.startsWith("~/") || s.startsWith("~\\")) {
    return path.join(os.homedir(), s.slice(2));
  }
  if (s === "~") {
    return os.homedir();
  }
  return s;
}
function service() { const dir = override ?? path.join(resolvePluginDataRoot(), 'attachments'); return sharedAdapterService('attachments',dir,()=>createAttachmentStore({dataDir:()=>dir,allowedLocalRoots:()=>[path.join(os.homedir(),'.openclaw','workspace'),path.join(os.homedir(),'.openclaw','media','inbound'),dir],normalizeMediaPath:normalizeAgentMediaPath,logger:createFridayNextLogger('files')})); }
export const getAttachmentsDir = (...args: Parameters<ReturnType<typeof createAttachmentStore>['getAttachmentsDir']>) => service().getAttachmentsDir(...args);
export const clearFileIndexForTest = (...args: Parameters<ReturnType<typeof createAttachmentStore>['clearFileIndexForTest']>) => service().clearFileIndexForTest(...args);
export const rememberInboundMediaName = (...args: Parameters<ReturnType<typeof createAttachmentStore>['rememberInboundMediaName']>) => service().rememberInboundMediaName(...args);
export const readAttachmentFileFromDisk = (...args: Parameters<ReturnType<typeof createAttachmentStore>['readAttachmentFileFromDisk']>) => service().readAttachmentFileFromDisk(...args);
export const storeFile = (...args: Parameters<ReturnType<typeof createAttachmentStore>['storeFile']>) => service().storeFile(...args);
export const storeFileWithStableId = (...args: Parameters<ReturnType<typeof createAttachmentStore>['storeFileWithStableId']>) => service().storeFileWithStableId(...args);
export const getFile = (...args: Parameters<ReturnType<typeof createAttachmentStore>['getFile']>) => service().getFile(...args);
export const fridayAttachmentLookupKey = (...args: Parameters<ReturnType<typeof createAttachmentStore>['fridayAttachmentLookupKey']>) => service().fridayAttachmentLookupKey(...args);
export const fridayFilesPublicUrl = (...args: Parameters<ReturnType<typeof createAttachmentStore>['fridayFilesPublicUrl']>) => service().fridayFilesPublicUrl(...args);
export const getExternalFileSourceByUrlToken = (...args: Parameters<ReturnType<typeof createAttachmentStore>['getExternalFileSourceByUrlToken']>) => service().getExternalFileSourceByUrlToken(...args);
export const readFile = (...args: Parameters<ReturnType<typeof createAttachmentStore>['readFile']>) => service().readFile(...args);
export const resolveMediaUrl = (...args: Parameters<ReturnType<typeof createAttachmentStore>['resolveMediaUrl']>) => service().resolveMediaUrl(...args);
export const resolveMediaAttachment = (...args: Parameters<ReturnType<typeof createAttachmentStore>['resolveMediaAttachment']>) => service().resolveMediaAttachment(...args);
export const resolveServerLocalFile = (...args: Parameters<ReturnType<typeof createAttachmentStore>['resolveServerLocalFile']>) => service().resolveServerLocalFile(...args);
export const guessMimeType = (...args: Parameters<ReturnType<typeof createAttachmentStore>['guessMimeType']>) => service().guessMimeType(...args);

export function getAttachmentStore() { return service(); }
