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
  // uploadAssessmentExcel,
  createAssessmentFromExcel,
  getUserResultsByRole,
  getAnalyticsByRole,
  getAssessmentQuestions,
  assignAssessmentBulk,
  getAssessmentById,
} from "../controller/assessmentsController.js";
import { uploadExcel } from "../middleware/uploadExcel.js";

const router = express.Router();

router.use(requireAuth);

router.get("/results/me", getMyResults);
router.get("/attempts/:attemptId/result", getAttemptResult);

router.post("/", allowRoles(1, 2, 3), createAssessment);

// MAIN NEW API (IMPORTANT)
router.post(
  "/import-excel",
  allowRoles(1, 2, 3),
  uploadExcel.single("file"),
  createAssessmentFromExcel
);

// // ---------- OPTIONAL (existing assessment upload) ----------
// router.post(
//   "/:assessmentId/upload-excel",
//   allowRoles(1, 2, 3),
//   uploadExcel.single("file"),
//   uploadAssessmentExcel
// );

router.get("/", getAssessments);

router.post("/:assessmentId/start", startAssessment);
router.post("/:assessmentId/submit", submitAssessment);
router.get("/:assessmentId/analytics", allowRoles(1, 2, 3), getAssessmentAnalytics);

router.get(
  "/results/users",
  allowRoles(1, 2, 3, 4),
  getUserResultsByRole
);

router.get(
  "/analytics/users",
  allowRoles(1, 2, 3, 4),
  getAnalyticsByRole
);

router.get(
  "/:assessmentId/questions",
  getAssessmentQuestions
); 

router.get("/:assessmentId", getAssessmentById);
router.put("/:assessmentId", allowRoles(1, 2, 3), updateAssessment);
router.put("/:assessmentId/questions", allowRoles(1, 2, 3), updateAssessmentQuestions);
router.put("/questions/:questionId/options", allowRoles(1, 2, 3), updateQuestionOptions);
router.post("/:assessmentId/assign-bulk", assignAssessmentBulk);
router.delete("/:assessmentId", allowRoles(1, 2, 3), deleteAssessment);
router.delete("/questions/:questionId", allowRoles(1, 2, 3), deleteQuestion);
router.delete("/options/:optionId", allowRoles(1, 2, 3), deleteOption);
router.get("/:assessmentId", getAssessmentById);
export default router;