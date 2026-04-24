import express from "express";
import { requireAuth } from "../middleware/requireAuth.js";
import { allowRoles } from "../middleware/rbac.js";

import {
  createAssessment,
  getAssessments,
  getAssessmentById,
  updateAssessment,
  deleteAssessment,
  startAssessment,
  submitAssessment,
  getAttemptResult,
  getMyResults,
  getAssessmentAnalytics,
} from "../controller/assessmentsController.js";

const router = express.Router();

router.use(requireAuth);

router.get("/results/me", getMyResults);
router.get("/attempts/:attemptId/result", getAttemptResult);

router.post("/", allowRoles(1, 2, 3), createAssessment);
router.get("/", getAssessments);

router.post("/:assessmentId/start", startAssessment);
router.post("/:assessmentId/submit", submitAssessment);
router.get("/:assessmentId/analytics", allowRoles(1, 2, 3), getAssessmentAnalytics);

router.get("/:assessmentId", getAssessmentById);
router.put("/:assessmentId", allowRoles(1, 2, 3), updateAssessment);
router.delete("/:assessmentId", allowRoles(1, 2, 3), deleteAssessment);

export default router;