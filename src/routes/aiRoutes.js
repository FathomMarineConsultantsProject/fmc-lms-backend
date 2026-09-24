import { Router } from "express";
import { requireAuth } from "../middleware/requireAuth.js";
import { allowRoles } from "../middleware/rbac.js";
import { handleChatBotQuery } from "../controller/aiController.js"
import { generateCourseDescription, generateTableOfContents, generateAssessmentQuestions } from "../controller/aiController.js";

const router = Router();

router.use(requireAuth);

router.post('/chat', handleChatBotQuery);
router.post('/generate-description', generateCourseDescription);
router.post('/generate-toc', generateTableOfContents);
router.post('/generate-assessment', allowRoles(1, 2, 3), generateAssessmentQuestions);

export default router;
