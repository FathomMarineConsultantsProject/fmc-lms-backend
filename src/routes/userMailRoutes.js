import express from "express";
import { requireAuth } from "../middleware/requireAuth.js";
import { createRateLimiter } from "../middleware/rateLimit.js";
import {
  sendCredentialsSingle,
  sendCredentialsBulk,
} from "../controller/userMailController.js";

const router = express.Router();

// 5 mails per minute per requester user_id
const mailLimiter = createRateLimiter({
  windowMs: 60_000,
  max: 5,
  keyFn: (req) => `mail:${req.user?.user_id || req.ip}`,
  message: "Mail limit reached (5 per minute). Please try again in a minute.",
});

router.post("/send-credentials", requireAuth, mailLimiter, sendCredentialsSingle);
router.post("/send-credentials/bulk", requireAuth, mailLimiter, sendCredentialsBulk);

export default router;
