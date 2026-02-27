// src/routes/integrationRoutes.js
import { Router } from "express";
import { requireAuth } from "../middleware/requireAuth.js";
import { allowRoles } from "../middleware/rbac.js";
import {
  googleConnect,
  googleCallback,
  googleStatus,
  zoomConnect, zoomCallback, zoomStatus, 
} from "../controller/integrationController.js";

export const router = Router();

/**
 * NOTE:
 * /integrations/google/connect requires JWT because we need req.user.company_id
 * /integrations/google/callback must NOT require JWT (Google calls it)
 * /integrations/google/status requires JWT
 */
// ------------------ Goggle----------
// Start OAuth (Admin / Subadmin / Superadmin only)
router.get("/google/connect", requireAuth, allowRoles(1, 2, 3), googleConnect);

// OAuth callback (Google redirects here)
router.get("/google/callback", googleCallback);

// Check connected
router.get("/google/status", requireAuth, allowRoles(1, 2, 3), googleStatus);

// ----------------- Zoom -----------------
router.get("/zoom/connect", requireAuth, allowRoles(1, 2, 3), zoomConnect);
router.get("/zoom/callback", zoomCallback);
router.get("/zoom/status", requireAuth, allowRoles(1, 2, 3), zoomStatus);