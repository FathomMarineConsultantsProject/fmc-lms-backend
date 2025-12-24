// src/routes/authRoutes.js
import { Router } from "express";
import { requireAuth } from "../middleware/requireAuth.js";
import { allowRoles } from "../middleware/rbac.js";
import {
  login,
  signup,
  forgotPassword,
  resetPassword,
  refreshAccessToken,
  logout,
  adminViewPassword,
  adminSetPassword,
} from "../controller/authController.js";

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
 *     summary: Login and get access + refresh tokens
 *     description: Returns access_token + refresh_token if credentials are valid and user status is onboard.
 *     tags: [Auth]
 *     security: []
 */
router.post("/login", login);

/**
 * @openapi
 * /auth/signup:
 *   post:
 *     summary: Signup (individual registration)
 *     tags: [Auth]
 *     security: []
 */
router.post("/signup", signup);

/**
 * @openapi
 * /auth/forgot-password:
 *   post:
 *     summary: Generate reset token (no email flow)
 *     tags: [Auth]
 *     security: []
 */
router.post("/forgot-password", forgotPassword);

/**
 * @openapi
 * /auth/reset-password:
 *   post:
 *     summary: Reset password using reset token
 *     tags: [Auth]
 *     security: []
 */
router.post("/reset-password", resetPassword);

/**
 * @openapi
 * /auth/refresh:
 *   post:
 *     summary: Refresh access token using refresh token
 *     tags: [Auth]
 *     security: []   # public
 */
router.post("/refresh", refreshAccessToken);

/**
 * @openapi
 * /auth/logout:
 *   post:
 *     summary: Logout (revoke refresh token)
 *     tags: [Auth]
 *     security:
 *       - bearerAuth: []
 */
router.post("/logout", requireAuth, logout);

/**
 * @openapi
 * /auth/admin/users/{user_id}/password:
 *   get:
 *     summary: Admin view user password (unsafe requirement)
 *     tags: [Auth]
 *     security:
 *       - bearerAuth: []
 */
router.get(
  "/admin/users/:user_id/password",
  requireAuth,
  allowRoles(1, 2, 3),
  adminViewPassword
);

/**
 * @openapi
 * /auth/admin/users/{user_id}/password:
 *   put:
 *     summary: Admin set/change user password
 *     tags: [Auth]
 *     security:
 *       - bearerAuth: []
 */
router.put(
  "/admin/users/:user_id/password",
  requireAuth,
  allowRoles(1, 2, 3),
  adminSetPassword
);
