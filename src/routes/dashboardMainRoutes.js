import express from "express";
import { requireAuth } from "../middleware/requireAuth.js";
import { allowRoles } from "../middleware/rbac.js";

import {
  getRecentUsers,
  getAllUsers,
  getNewUsersLast7Days
} from "../controller/dashboardMainController.js";

const router = express.Router();

// Super Admin only
router.get(
  "/users/recent",
  requireAuth,
  allowRoles(1,2),
  getRecentUsers
);

router.get(
  "/users",
  requireAuth,
  allowRoles(1,2),
  getAllUsers
);

// Super Admin and Admin only
router.get(
  "/users/recent/all",
  requireAuth,
  allowRoles(1, 2),
  getNewUsersLast7Days
);
export default router;