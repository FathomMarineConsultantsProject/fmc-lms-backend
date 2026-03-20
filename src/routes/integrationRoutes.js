import { Router } from "express";
import { requireAuth } from "../middleware/requireAuth.js";
import { allowRoles } from "../middleware/rbac.js";
import {
  googleConnect,
  googleCallback,
  googleStatus,
  zoomConnect,
  zoomCallback,
  zoomStatus,
  teamsConnect,
  teamsCallback,
  teamsStatus,
} from "../controller/integrationController.js";

export const router = Router();

router.get("/google/connect", requireAuth, allowRoles(1, 2, 3, 4), googleConnect);
router.get("/google/callback", googleCallback);
router.get("/google/status", requireAuth, allowRoles(1, 2, 3, 4), googleStatus);

router.get("/zoom/connect", requireAuth, allowRoles(1, 2, 3, 4), zoomConnect);
router.get("/zoom/callback", zoomCallback);
router.get("/zoom/status", requireAuth, allowRoles(1, 2, 3, 4), zoomStatus);

router.get("/teams/connect", requireAuth, allowRoles(1, 2, 3, 4), teamsConnect);
router.get("/teams/callback", teamsCallback);
router.get("/teams/status", requireAuth, allowRoles(1, 2, 3, 4), teamsStatus);