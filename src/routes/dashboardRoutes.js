
import express from "express";

import {
  getTrainingDashboard,
  getShipTrainingDashboard,
  getSeafarerTrainingDashboard,
} from "../controllers/dashboardController.js";

import { requireAuth } from "../middleware/requireAuth.js";
import { allowRoles } from "../middleware/rbac.js";

const router = express.Router();


router.use(requireAuth);
router.use(allowRoles(1));

router.get("/dashboard", getTrainingDashboard);

router.get(
  "/dashboard/ships/:shipId",
  getShipTrainingDashboard
);

router.get(
  "/dashboard/users/:userId",
  getSeafarerTrainingDashboard
);

export default router;