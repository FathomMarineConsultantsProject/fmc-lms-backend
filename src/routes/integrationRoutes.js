import { Router } from "express";
import { requireAuth } from "../middleware/requireAuth.js";
import { allowRoles } from "../middleware/rbac.js";
import {
  googleConnect,
  googleCallback,
  googleStatus,
} from "../controller/integrationController.js";

export const router = Router();

/**
 * Only Admin roles should connect integrations
 * 1 = Superadmin, 2 = Admin, 3 = Subadmin
 */
router.get("/google/connect", requireAuth, allowRoles(1, 2, 3), googleConnect);

/**
 * Callback is opened by Google directly (no JWT available)
 */
router.get("/google/callback", googleCallback);

/**
 * FE checks if integration is connected
 */
router.get("/google/status", requireAuth, allowRoles(1, 2, 3), googleStatus);