import path from 'node:path';
import { createPairingVoucherStore } from '@syengup/fridaynext-channel-kit/public-access/pairing-voucher';
import { resolvePluginDataRoot, sharedAdapterService } from '../adapters/openclaw/environment.js';
export type * from '@syengup/fridaynext-channel-kit/public-access/pairing-voucher';
let override: string | null = null;
export function setPairingVoucherDirForTest(value: string): void { override = value; }
function service() { const dir=override??path.join(resolvePluginDataRoot(),'public-access');return sharedAdapterService('pairing-voucher',dir,()=>createPairingVoucherStore({dataDir:dir})); }
export const mintPairingVoucher = (...args: Parameters<ReturnType<typeof createPairingVoucherStore>['mintPairingVoucher']>) => service().mintPairingVoucher(...args);
export const claimPairingVoucher = (...args: Parameters<ReturnType<typeof createPairingVoucherStore>['claimPairingVoucher']>) => service().claimPairingVoucher(...args);
export const clearPairingVoucher = (...args: Parameters<ReturnType<typeof createPairingVoucherStore>['clearPairingVoucher']>) => service().clearPairingVoucher(...args);
