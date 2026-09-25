import { Router } from "express";
import { requireAuth } from "../middleware/requireAuth.js";
import { allowRoles } from "../middleware/rbac.js";
import { handleChatBotQuery } from "../controller/aiController.js"
import { generateCourseDescription, generateTableOfContents, generateAssessmentQuestions, regenerateAssessmentQuestion, fillIncidentReport } from "../controller/aiController.js";

const router = Router();

router.use(requireAuth);

router.post('/chat', handleChatBotQuery);
router.post('/generate-description', generateCourseDescription);
router.post('/generate-toc', generateTableOfContents);
router.post('/generate-assessment', allowRoles(1, 2, 3), generateAssessmentQuestions);
router.post('/regenerate-assessment-question', allowRoles(1, 2, 3), regenerateAssessmentQuestion);
router.post('/fill-incident-report', allowRoles(1, 2, 3, 4), fillIncidentReport);

export default router;
