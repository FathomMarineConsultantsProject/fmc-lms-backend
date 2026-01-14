import express from "express";
import { requireAuth } from "../middleware/requireAuth.js";
import { sendTestMail } from "../controller/mailTestController.js";

const router = express.Router();

// Keep it protected so random people can't use your SMTP
router.post("/test-mail", requireAuth, sendTestMail);

export default router;
