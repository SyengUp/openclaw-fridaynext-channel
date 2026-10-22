import { createPromptCapsuleHandler } from "@syengup/fridaynext-channel-kit/transport/prompt-capsules";
import { extractBearerToken } from "../middleware/auth.js";
import * as store from "../../prompt-capsules/capsules-store.js";

export const handlePromptCapsules = createPromptCapsuleHandler({ authenticate: (req) => extractBearerToken(req) !== null, store }).handlePromptCapsules;
