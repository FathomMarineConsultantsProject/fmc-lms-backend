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
  updateAssessmentQuestions,
  updateQuestionOptions,
  deleteQuestion,
  deleteOption,
} from "../controller/assessmentsController.js";

const router = express.Router(); .0

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
router.put("/:assessmentId/questions", allowRoles(1, 2, 3), updateAssessmentQuestions);
router.put("/questions/:questionId/options", allowRoles(1, 2, 3), updateQuestionOptions);

router.delete("/:assessmentId", allowRoles(1, 2, 3), deleteAssessment);
router.delete("/questions/:questionId", allowRoles(1, 2, 3), deleteQuestion);
router.delete("/options/:optionId", allowRoles(1, 2, 3), deleteOption);

export default router;