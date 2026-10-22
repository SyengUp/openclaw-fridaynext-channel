import {createPairingHandlers} from "@syengup/fridaynext-channel-kit/transport/pairing";
import {extractBearerToken} from "../middleware/auth.js";
import {getPairingInfo} from "../../public-access/frpc-manager.js";
import * as vouchers from "../../public-access/pairing-voucher.js";
import {createFridayNextLogger} from "../../logging.js";
export const {handlePublicAccessPairing,handlePairClaim,resetPairClaimRateLimiter}=createPairingHandlers({
  authenticate:req=>extractBearerToken(req)!==null,getPairingInfo,vouchers,logger:createFridayNextLogger("pairing","info")});
