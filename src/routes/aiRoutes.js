import { Router } from "express";
import { requireAuth } from "../middleware/requireAuth.js";
import { handleChatBotQuery } from "../controller/aiController.js"

const router = Router();

router.use(requireAuth);

router.post('/chat', handleChatbotQuery);

export default router;