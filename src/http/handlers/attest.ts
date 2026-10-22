import { createAttestHandlers } from "@syengup/fridaynext-channel-kit/transport/attest";
import {
  verifyAttestation,
  verifyAssertion,
} from "@syengup/fridaynext-channel-kit/attest/verifier";
import { extractBearerToken } from "../middleware/auth.js";
import { resolveFridayNextConfig } from "../../config.js";
import { getHostOpenClawConfigSnapshot } from "../../host-config.js";
import { getFridayNextRuntime } from "../../runtime.js";
import { createFridayNextLogger } from "../../logging.js";
import * as store from "../../attest/attest-store.js";
const handlers = createAttestHandlers({
  authenticate: (req) => extractBearerToken(req) !== null,
  policy: () =>
    resolveFridayNextConfig(getHostOpenClawConfigSnapshot(getFridayNextRuntime().config)).appAttest,
  store,
  verifyAttestation,
  verifyAssertion,
  warn: (message) => createFridayNextLogger("attest").warn(message),
});
export const { handleAttestChallenge, handleAttestVerify, handleAttestRefresh } = handlers;
