// src/routes/incidentRoutes.js
import { Router } from "express";
import { requireAuth } from "../middleware/requireAuth.js";
import {
  getAllIncidents,
  getIncidentById,
  createIncident,
  updateIncident,
  deleteIncident,
} from "../controller/incidentsController.js";

export const router = Router();

/**
 * @openapi
 * tags:
 *   - name: Incidents
 *     description: Incident management
 */

router.use(requireAuth);

/**
 * @openapi
 * /incidents:
 *   get:
 *     summary: Get all incidents
 *     tags: [Incidents]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200: { description: OK }
 */
router.get("/", getAllIncidents);

/**
 * @openapi
 * /incidents/{id}:
 *   get:
 *     summary: Get incident by ID
 *     tags: [Incidents]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: OK }
 */
router.get("/:id", getIncidentById);

/**
 * @openapi
 * /incidents:
 *   post:
 *     summary: Create incident
 *     tags: [Incidents]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             additionalProperties: true
 *     responses:
 *       201: { description: Created }
 */
router.post("/", createIncident);

/**
 * @openapi
 * /incidents/{id}:
 *   put:
 *     summary: Update incident
 *     tags: [Incidents]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Updated }
 */
router.put("/:id", updateIncident);

/**
 * @openapi
 * /incidents/{id}:
 *   delete:
 *     summary: Delete incident
 *     tags: [Incidents]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Deleted }
 */
router.delete("/:id", deleteIncident);
