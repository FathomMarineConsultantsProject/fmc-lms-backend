import { Router } from "express";
import { requireAuth } from "../middleware/requireAuth.js";
import { allowRoles } from "../middleware/rbac.js";
import { createRateLimiter } from "../middleware/rateLimit.js";
import { handleChatBotQuery, generateCourseDescription, generateTableOfContents, generateAssessmentDraft } from "../controller/aiController.js";

const router = Router();

router.use(requireAuth);

const assessmentGenerationLimiter = createRateLimiter({
  windowMs: 60_000,
  max: 6,
  keyFn: (req) => `ai-assessment:${req.user?.user_id || req.ip}`,
  message: "Assessment generation limit reached. Please try again in a minute.",
});

router.post('/chat', handleChatBotQuery);
router.post('/generate-description', generateCourseDescription);
router.post('/generate-toc', generateTableOfContents);
router.post('/generate-assessment', allowRoles(1, 2, 3), assessmentGenerationLimiter, generateAssessmentDraft);

export default router;
