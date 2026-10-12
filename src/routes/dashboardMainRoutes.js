import express from "express";
import { requireAuth } from "../middleware/requireAuth.js";
import { allowRoles } from "../middleware/rbac.js";

import {
    getRecentUsers,
    getAllUsers,
} from "../controller/dashboardMainController.js";

const router = express.Router();

// Super Admin only
router.get(
    "/users/recent",
    requireAuth,
    allowRoles("superadmin"),
    getRecentUsers
);

router.get(
    "/users",
    requireAuth,
    allowRoles("superadmin"),
    getAllUsers
);

export default router;