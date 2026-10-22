import path from 'node:path';
import { createPublicAccessManager } from '@syengup/fridaynext-channel-kit/public-access/frpc-manager';
export { TunnelHealthTracker } from '@syengup/fridaynext-channel-kit/public-access/frpc-manager';
export type * from '@syengup/fridaynext-channel-kit/public-access/frpc-manager';
import { resolvePluginDataRoot, sharedAdapterService } from '../adapters/openclaw/environment.js';
import { startFilterProxy, stopFilterProxy } from './filter-proxy.js';
import { verifySession } from '../attest/attest-store.js';
import { resolveFridayNextConfig } from '../config.js';
import { getHostOpenClawConfigSnapshot } from '../host-config.js';
import { getFridayNextRuntime } from '../runtime.js';
function service() {
 const dir=process.env.FRIDAY_NEXT_PUBLIC_ACCESS_DATA_DIR?.trim() || path.join(resolvePluginDataRoot(),'public-access');
 return sharedAdapterService('public-access',dir,()=>createPublicAccessManager({dataDir:dir,role:()=>process.env.OPENCLAW_SERVICE_KIND==='gateway'?'service':'ambient',gateRequired:()=>resolveFridayNextConfig(getHostOpenClawConfigSnapshot(getFridayNextRuntime().config)).appAttest.gatePublicSurfaces,verifySession,startFilterProxy,stopFilterProxy}));
}
export const expectedFrpcArchiveSHA256 = (...args: Parameters<ReturnType<typeof createPublicAccessManager>['expectedFrpcArchiveSHA256']>) => service().expectedFrpcArchiveSHA256(...args);
export const frpcArchiveFileName = (...args: Parameters<ReturnType<typeof createPublicAccessManager>['frpcArchiveFileName']>) => service().frpcArchiveFileName(...args);
export const frpcDownloadSources = (...args: Parameters<ReturnType<typeof createPublicAccessManager>['frpcDownloadSources']>) => service().frpcDownloadSources(...args);
export const isTunnelHealthyStatus = (...args: Parameters<ReturnType<typeof createPublicAccessManager>['isTunnelHealthyStatus']>) => service().isTunnelHealthyStatus(...args);
export const pickLanIpFromInterfaces = (...args: Parameters<ReturnType<typeof createPublicAccessManager>['pickLanIpFromInterfaces']>) => service().pickLanIpFromInterfaces(...args);
export const resolveRelayCredentials = (...args: Parameters<ReturnType<typeof createPublicAccessManager>['resolveRelayCredentials']>) => service().resolveRelayCredentials(...args);
export const discardLocalSubdomainAllocation = (...args: Parameters<ReturnType<typeof createPublicAccessManager>['discardLocalSubdomainAllocation']>) => service().discardLocalSubdomainAllocation(...args);
export const shouldClearRecordedFrpcPid = (...args: Parameters<ReturnType<typeof createPublicAccessManager>['shouldClearRecordedFrpcPid']>) => service().shouldClearRecordedFrpcPid(...args);
export const pluginFrpcPidsFromProcessList = (...args: Parameters<ReturnType<typeof createPublicAccessManager>['pluginFrpcPidsFromProcessList']>) => service().pluginFrpcPidsFromProcessList(...args);
export const claimPublicAccessOwnership = (...args: Parameters<ReturnType<typeof createPublicAccessManager>['claimPublicAccessOwnership']>) => service().claimPublicAccessOwnership(...args);
export const currentProcessOwnsPublicAccess = (...args: Parameters<ReturnType<typeof createPublicAccessManager>['currentProcessOwnsPublicAccess']>) => service().currentProcessOwnsPublicAccess(...args);
export const releasePublicAccessOwnership = (...args: Parameters<ReturnType<typeof createPublicAccessManager>['releasePublicAccessOwnership']>) => service().releasePublicAccessOwnership(...args);
export const startPublicAccess = (...args: Parameters<ReturnType<typeof createPublicAccessManager>['startPublicAccess']>) => service().startPublicAccess(...args);
export const reconcileServedSubdomains = (...args: Parameters<ReturnType<typeof createPublicAccessManager>['reconcileServedSubdomains']>) => service().reconcileServedSubdomains(...args);
export const isValidSubdomainLabel = (...args: Parameters<ReturnType<typeof createPublicAccessManager>['isValidSubdomainLabel']>) => service().isValidSubdomainLabel(...args);
export const normalizedServedSubdomains = (...args: Parameters<ReturnType<typeof createPublicAccessManager>['normalizedServedSubdomains']>) => service().normalizedServedSubdomains(...args);
export const stopPublicAccess = (...args: Parameters<ReturnType<typeof createPublicAccessManager>['stopPublicAccess']>) => service().stopPublicAccess(...args);
export const currentServedSubdomains = (...args: Parameters<ReturnType<typeof createPublicAccessManager>['currentServedSubdomains']>) => service().currentServedSubdomains(...args);
export const getPairingInfo = (...args: Parameters<ReturnType<typeof createPublicAccessManager>['getPairingInfo']>) => service().getPairingInfo(...args);

export function getPublicAccessManager() { return service(); }
