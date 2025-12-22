// src/routes/assessmentRoutes.js
import { Router } from "express";
import { requireAuth } from "../middleware/requireAuth.js";
import { allowRoles } from "../middleware/rbac.js";
import {
  getAllAssessments,
  getAssessmentById,
  createAssessment,
  updateAssessment,
  deleteAssessment,
} from "../controller/assessmentsController.js";

export const router = Router();

/**
 * @openapi
 * tags:
 *   - name: Assessments
 *     description: Assessment management
 */

router.use(requireAuth);

/**
 * @openapi
 * /assessments:
 *   get:
 *     summary: Get all assessments
 *     tags: [Assessments]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200: { description: OK }
 */
router.get("/", allowRoles(1, 2, 3, 4), getAllAssessments);

/**
 * @openapi
 * /assessments/{id}:
 *   get:
 *     summary: Get assessment by ID
 *     tags: [Assessments]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: OK }
 *       404: { description: Not found }
 */
router.get("/:id", allowRoles(1, 2, 3, 4), getAssessmentById);

/**
 * @openapi
 * /assessments:
 *   post:
 *     summary: Create assessment
 *     tags: [Assessments]
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
router.post("/", allowRoles(1, 2, 3), createAssessment);

/**
 * @openapi
 * /assessments/{id}:
 *   put:
 *     summary: Update assessment
 *     tags: [Assessments]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             additionalProperties: true
 *     responses:
 *       200: { description: Updated }
 */
router.put("/:id", allowRoles(1, 2, 3), updateAssessment);

/**
 * @openapi
 * /assessments/{id}:
 *   delete:
 *     summary: Delete assessment
 *     tags: [Assessments]
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
router.delete("/:id", allowRoles(1, 2, 3), deleteAssessment);
