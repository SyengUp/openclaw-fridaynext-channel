import path from 'node:path';
import os from 'node:os';
import { createAttestStore } from '@syengup/fridaynext-channel-kit/attest/attest-store';
import { sharedAdapterService } from '../adapters/openclaw/environment.js';
export type * from '@syengup/fridaynext-channel-kit/attest/attest-store';
function service() { const dir=path.join(os.homedir(),'.openclaw','friday-next','attest');return sharedAdapterService('attest',dir,()=>createAttestStore({dataDir:dir,maxKeys:Number(process.env.FRIDAY_NEXT_ATTEST_KEYS_MAX||200),deadAfterMs:Number(process.env.FRIDAY_NEXT_ATTEST_KEY_DEAD_AFTER_SEC||86400)*1000})); }
export const getKey = (...args: Parameters<ReturnType<typeof createAttestStore>['getKey']>) => service().getKey(...args);
export const saveKey = (...args: Parameters<ReturnType<typeof createAttestStore>['saveKey']>) => service().saveKey(...args);
export const updateSignCount = (...args: Parameters<ReturnType<typeof createAttestStore>['updateSignCount']>) => service().updateSignCount(...args);
export const _resetKeysForTest = (...args: Parameters<ReturnType<typeof createAttestStore>['_resetKeysForTest']>) => service()._resetKeysForTest(...args);
export const _keysForTest = (...args: Parameters<ReturnType<typeof createAttestStore>['_keysForTest']>) => service()._keysForTest(...args);
export const issueChallenge = (...args: Parameters<ReturnType<typeof createAttestStore>['issueChallenge']>) => service().issueChallenge(...args);
export const consumeChallenge = (...args: Parameters<ReturnType<typeof createAttestStore>['consumeChallenge']>) => service().consumeChallenge(...args);
export const _setSessionSecretForTest = (...args: Parameters<ReturnType<typeof createAttestStore>['_setSessionSecretForTest']>) => service()._setSessionSecretForTest(...args);
export const issueSession = (...args: Parameters<ReturnType<typeof createAttestStore>['issueSession']>) => service().issueSession(...args);
export const verifySession = (...args: Parameters<ReturnType<typeof createAttestStore>['verifySession']>) => service().verifySession(...args);
