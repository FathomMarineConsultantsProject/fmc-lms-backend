
import express from "express";

import {
  getTrainingDashboard,
  getShipTrainingDashboard,
  getSeafarerTrainingDashboard,
  getAssessmentUsers,
  getUserAssessmentDetails,
} from "../controller/dashboardController.js"

import { requireAuth } from "../middleware/requireAuth.js";
import { allowRoles } from "../middleware/rbac.js";

const router = express.Router();


router.use(requireAuth);
router.use(allowRoles(1,2));

router.get("/dashboard", getTrainingDashboard);

router.get(
  "/dashboard/ships/:shipId",
  getShipTrainingDashboard
);

router.get(
  "/dashboard/users/:userId",
  getSeafarerTrainingDashboard
);

router.get(
  "/assessments/users",
  getAssessmentUsers
);

router.get(
  "/assessments/users/:userId/assessments",
  getUserAssessmentDetails
);

export default router;