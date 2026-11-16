import { Router } from "express";
import multer from "multer";
import { requireAuth } from "../middleware/requireAuth.js";
import { allowRoles } from "../middleware/rbac.js";
import { handleChatBotQuery } from "../controller/aiController.js"
import { generateCourseDescription, generateTableOfContents, generateAssessmentQuestions, regenerateAssessmentQuestion, fillIncidentReport, extractIncidentFromPdf } from "../controller/aiController.js";

const router = Router();

router.use(requireAuth);

// PDF upload configuration
const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 20 * 1024 * 1024 // 20 MB
    },
    fileFilter: (req, file, cb) => {
        if (
            file.mimetype !== "application/pdf" &&
            !file.originalname.toLowerCase().endsWith(".pdf")
        ) {
            return cb(new Error("Only PDF files are allowed."));
        }

        cb(null, true);
    }
});

router.post('/chat', handleChatBotQuery);
router.post('/generate-description', generateCourseDescription);
router.post('/generate-toc', generateTableOfContents);
router.post('/generate-assessment', allowRoles(1, 2, 3), generateAssessmentQuestions);
router.post('/regenerate-assessment-question', allowRoles(1, 2, 3), regenerateAssessmentQuestion);
router.post('/fill-incident-report', allowRoles(1, 2, 3, 4), fillIncidentReport);
router.post(
    '/extract-incident-pdf',
    allowRoles(1, 2, 3, 4),
    upload.single("file"),
    extractIncidentFromPdf
);
export default router;
