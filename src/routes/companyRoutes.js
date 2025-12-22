// src/routes/companyRoutes.js
import { Router } from "express";
import { requireAuth } from "../middleware/requireAuth.js";
import {
  getAllCompanies,
  getCompanyById,
  createCompany,
  updateCompany,
  deleteCompany,
} from "../controller/companyController.js";

export const router = Router();

/**
 * @openapi
 * tags:
 *   - name: Companies
 *     description: Company management
 */

router.use(requireAuth);

/**
 * @openapi
 * /companies:
 *   get:
 *     summary: Get all companies
 *     description: |
 *       Role 1 (SuperAdmin) gets all companies.
 *       Other roles get only their own company (based on token company_id).
 *     tags: [Companies]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: OK
 *       401:
 *         description: Unauthorized
 */
router.get("/", getAllCompanies);

/**
 * @openapi
 * /companies/{id}:
 *   get:
 *     summary: Get company by ID
 *     description: |
 *       Role 1 can access any company.
 *       Other roles can only access their own company (company scope).
 *     tags: [Companies]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Company UUID
 *     responses:
 *       200:
 *         description: OK
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden (company scope)
 *       404:
 *         description: Company not found
 */
router.get("/:id", getCompanyById);

/**
 * @openapi
 * /companies:
 *   post:
 *     summary: Create a company
 *     description: SuperAdmin only (role 1).
 *     tags: [Companies]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - company_name
 *             properties:
 *               company_name:
 *                 type: string
 *               code:
 *                 type: string
 *               email_domain:
 *                 type: string
 *               is_active:
 *                 type: boolean
 *               metadata_json:
 *                 type: object
 *               ships_count:
 *                 type: integer
 *               role:
 *                 type: string
 *               regional_address:
 *                 type: string
 *               ism_address:
 *                 type: string
 *               type:
 *                 type: string
 *               contact_person_name:
 *                 type: string
 *               phone_no:
 *                 type: string
 *               email:
 *                 type: string
 *               username:
 *                 type: string
 *               password_hash:
 *                 type: string
 *     responses:
 *       201:
 *         description: Created
 *       400:
 *         description: Bad request
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden
 */
router.post("/", createCompany);

/**
 * @openapi
 * /companies/{id}:
 *   put:
 *     summary: Update a company
 *     description: |
 *       Role 1 can update any company.
 *       Role 2 can update only their own company (company scope).
 *     tags: [Companies]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Company UUID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             additionalProperties: true
 *     responses:
 *       200:
 *         description: Updated
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden
 *       404:
 *         description: Company not found
 */
router.put("/:id", updateCompany);

/**
 * @openapi
 * /companies/{id}:
 *   delete:
 *     summary: Delete a company
 *     description: SuperAdmin only (role 1).
 *     tags: [Companies]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Company UUID
 *     responses:
 *       200:
 *         description: Deleted
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden
 *       404:
 *         description: Company not found
 */
router.delete("/:id", deleteCompany);
