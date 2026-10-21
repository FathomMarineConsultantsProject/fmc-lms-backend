// src/routes/incidentRoutes.js
import { Router } from "express";
import { requireAuth } from "../middleware/requireAuth.js";
import {
  getAllIncidents,
  getIncidentById,
  createIncident,
  updateIncident,
  deleteIncident,
  getRequestedTrainings,          
  getRecentTrainingRequestCount,  
  requestIncidentTraining,
  generateDashboard
} from "../controller/incidentsController.js";

export const router = Router();

/**
 * @openapi
 * tags:
 *   - name: Incidents
 *     description: Incident management
 */

router.use(requireAuth);

//New incident training routes
// Get all incidents that have a training requested (for dashboard notifications)
router.get("/training-requests", getRequestedTrainings);


//  Update an incident to flag it for training creation
router.post("/:id/request-training", requestIncidentTraining);

// count of recent trainings requested in last 7 days
router.get("/training-requests/recent-count", getRecentTrainingRequestCount);
//end



router.get("/", getAllIncidents);


router.get("/:id", getIncidentById);


router.post("/", createIncident);


router.put("/:id", updateIncident);


router.delete("/:id", deleteIncident);
//router.patch("/:id/details", updateIncidentDetails);
//ai
router.post('/:incident_id/generate-dashboard', generateDashboard);
