import * as shared from '@syengup/fridaynext-channel-kit/attest/attest-gate';
import { OPENCLAW_PUBLIC_POLICY } from '../adapters/openclaw/public-policy.js';
export type * from '@syengup/fridaynext-channel-kit/attest/attest-gate';
export const { ATTEST_HEADER, ATTEST_COOKIE, ATTEST_REJECTION_BODY, cookieValue, attestTokenFromHeaders } = shared;
export const isAttestExempt = (path: string) => shared.isAttestExempt(path, OPENCLAW_PUBLIC_POLICY.attest);
export const requiresAttestAtProxy = (path: string) => shared.requiresAttestAtProxy(path, OPENCLAW_PUBLIC_POLICY.attest);
export const attestCookieAllowedFor = (path: string) => shared.attestCookieAllowedFor(path, OPENCLAW_PUBLIC_POLICY.attest);
export const attestGateDecision = (args: Parameters<typeof shared.attestGateDecision>[0]) => shared.attestGateDecision({...args,policy:OPENCLAW_PUBLIC_POLICY.attest});
