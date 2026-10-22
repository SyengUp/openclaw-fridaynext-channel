import path from 'node:path';
import { createPromptCapsuleStore } from '@syengup/fridaynext-channel-kit/prompt-capsules/capsules-store';
import { resolvePluginDataRoot, sharedAdapterService } from '../adapters/openclaw/environment.js';
export type * from '@syengup/fridaynext-channel-kit/prompt-capsules/capsules-store';
let override: string | null = null;
export function setPromptCapsulesBaseDirForTest(value: string | null): void { override = value; }
function service() { const dir = override ?? path.join(resolvePluginDataRoot(), 'prompt-capsules'); return sharedAdapterService('prompt-capsules', dir, () => createPromptCapsuleStore({dataDir:dir})); }
export const resolvePromptCapsulesDir = (...args: Parameters<ReturnType<typeof createPromptCapsuleStore>['resolvePromptCapsulesDir']>) => service().resolvePromptCapsulesDir(...args);
export const readCapsules = (...args: Parameters<ReturnType<typeof createPromptCapsuleStore>['readCapsules']>) => service().readCapsules(...args);
export const readOrInitCapsules = (...args: Parameters<ReturnType<typeof createPromptCapsuleStore>['readOrInitCapsules']>) => service().readOrInitCapsules(...args);
export const writeCapsules = (...args: Parameters<ReturnType<typeof createPromptCapsuleStore>['writeCapsules']>) => service().writeCapsules(...args);
export const validateCapsulesPayload = (...args: Parameters<ReturnType<typeof createPromptCapsuleStore>['validateCapsulesPayload']>) => service().validateCapsulesPayload(...args);
export const MAX_CAPSULES = service().MAX_CAPSULES;
export const MAX_NAME_LEN = service().MAX_NAME_LEN;
export const MAX_ICON_LEN = service().MAX_ICON_LEN;
export const MAX_PROMPT_LEN = service().MAX_PROMPT_LEN;
export const DEFAULT_SEED_CAPSULES = service().DEFAULT_SEED_CAPSULES;
