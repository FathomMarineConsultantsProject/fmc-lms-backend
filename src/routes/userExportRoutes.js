// src/routes/userExportRoutes.js
import express from "express";
import { requireAuth } from "../middleware/requireAuth.js";
import { exportCrewExcel, exportSelectedCrewExcel } from "../controller/userExportController.js";

const router = express.Router();

// full export (filters via query)
router.get("/export/crew", requireAuth, exportCrewExcel);

// selection export (frontend sends ids)
router.post("/export/crew/selected", requireAuth, exportSelectedCrewExcel);

export default router;
