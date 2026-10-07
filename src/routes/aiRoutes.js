import { Router } from "express";
import { requireAuth } from "../middleware/requireAuth.js";
import { handleChatBotQuery } from "../controller/aiController.js"
import { generateCourseDescription, generateTableOfContents } from "../controller/aiController.js";

const router = Router();

router.use(requireAuth);

router.post('/chat', handleChatBotQuery);
router.post('/generate-description', generateCourseDescription);
router.post('/generate-toc', generateTableOfContents);

export default router;