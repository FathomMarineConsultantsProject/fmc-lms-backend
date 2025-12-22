// src/routes/authRoutes.js
import { Router } from "express";
import { login } from "../controller/authController.js";

export const router = Router();

/**
 * @openapi
 * tags:
 *   - name: Auth
 *     description: Authentication
 */

/**
 * @openapi
 * /auth/login:
 *   post:
 *     summary: Login and get JWT token
 *     description: Returns a JWT token if credentials are valid and user status is onboard.
 *     tags: [Auth]
 *     security: []   # IMPORTANT: makes this endpoint public (no bearer required)
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - username
 *               - password
 *             properties:
 *               username:
 *                 type: string
 *                 example: "fmc_admin"
 *               password:
 *                 type: string
 *                 example: "your_password"
 *     responses:
 *       200:
 *         description: Login successful
 *       400:
 *         description: Missing username/password
 *       401:
 *         description: Invalid credentials
 *       403:
 *         description: User not onboard (login disabled)
 *       500:
 *         description: Server error
 */
router.post("/login", login);
