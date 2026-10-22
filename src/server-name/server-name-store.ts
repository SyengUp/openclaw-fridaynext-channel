import path from 'node:path';
import { createServerNameStore } from '@syengup/fridaynext-channel-kit/server-name/server-name-store';
import { resolvePluginDataRoot, sharedAdapterService } from '../adapters/openclaw/environment.js';
export type * from '@syengup/fridaynext-channel-kit/server-name/server-name-store';
let override: string | null = null;
export function setServerNameBaseDirForTest(value: string | null): void { override = value; }
function service() { const dir = override ?? path.join(resolvePluginDataRoot(), 'server-info'); return sharedAdapterService('server-info', dir, () => createServerNameStore({dataDir:dir})); }
export const readServerName = (...args: Parameters<ReturnType<typeof createServerNameStore>['readServerName']>) => service().readServerName(...args);
export const writeServerName = (...args: Parameters<ReturnType<typeof createServerNameStore>['writeServerName']>) => service().writeServerName(...args);
export const validateServerName = (...args: Parameters<ReturnType<typeof createServerNameStore>['validateServerName']>) => service().validateServerName(...args);
export const MAX_SERVER_NAME_LEN = service().MAX_SERVER_NAME_LEN;
