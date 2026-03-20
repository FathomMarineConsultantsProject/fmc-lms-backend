// src/routes/certificateRoutes.js
import { Router } from "express";
import { requireAuth } from "../middleware/requireAuth.js";
import { allowRoles } from "../middleware/rbac.js";
import {
  getAllCertificates,
  getCertificateById,
  createCertificate,
  updateCertificate,
  deleteCertificate,
} from "../controller/certificatesController.js";

export const router = Router();

/**
 * @openapi
 * tags:
 *   - name: Certificates
 *     description: Certificate management
 */

router.use(requireAuth);

/**
 * @openapi
 * /certificates:
 *   get:
 *     summary: Get all certificates
 *     tags: [Certificates]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200: { description: OK }
 */
router.get("/", allowRoles(1, 2, 3, 4), getAllCertificates);

/**
 * @openapi
 * /certificates/{id}:
 *   get:
 *     summary: Get certificate by ID
 *     tags: [Certificates]
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
router.get("/:id", allowRoles(1, 2, 3, 4), getCertificateById);

/**
 * @openapi
 * /certificates:
 *   post:
 *     summary: Create certificate
 *     tags: [Certificates]
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
router.post("/", allowRoles(1, 2, 3), createCertificate);

/**
 * @openapi
 * /certificates/{id}:
 *   put:
 *     summary: Update certificate
 *     tags: [Certificates]
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
router.put("/:id", allowRoles(1, 2, 3), updateCertificate);

/**
 * @openapi
 * /certificates/{id}:
 *   delete:
 *     summary: Delete certificate
 *     tags: [Certificates]
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
router.delete("/:id", allowRoles(1, 2, 3), deleteCertificate);
