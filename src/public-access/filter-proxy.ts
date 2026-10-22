import * as shared from '@syengup/fridaynext-channel-kit/public-access/filter-proxy';
import { OPENCLAW_PUBLIC_POLICY } from '../adapters/openclaw/public-policy.js';
export type * from '@syengup/fridaynext-channel-kit/public-access/filter-proxy';
export const { stopFilterProxy, normalizedPath, isForwardedClientHeader } = shared;
export const allowed = (url: string) => shared.allowed(url,OPENCLAW_PUBLIC_POLICY);
export const startFilterProxy = (...args: Parameters<typeof shared.startFilterProxy>) => shared.startFilterProxy(args[0],args[1],args[2],args[3],OPENCLAW_PUBLIC_POLICY);
