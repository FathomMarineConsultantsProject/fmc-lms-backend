// src/routes/activityRoutes.js
import { Router } from 'express';
import { requireAuth } from '../middleware/requireAuth.js';
import { trackActivity, getActivityLogs } from '../controller/activityLogsController.js';

export const router = Router();

/**
 * @openapi
 * tags:
 *   - name: Activity
 *     description: Activity logging & audit trail
 */

/**
 * @openapi
 * /activity/track:
 *   post:
 *     summary: Track activity from external app (Unity)
 *     description: |
 *       Public endpoint (recommended to protect via X-Activity-Key header).
 *       Saves activity into activity_logs table.
 *     tags: [Activity]
 *     security: []
 *     parameters:
 *       - in: header
 *         name: X-Activity-Key
 *         required: false
 *         schema: { type: string }
 *         description: Optional API key for Unity tracking calls
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [username]
 *             properties:
 *               username: { type: string, example: "user5008" }
 *               trainingType: { type: string, example: "Training" }
 *               activityType: { type: string, example: "login" }
 *               timestamp: { type: string, example: "2025-12-24-09:28" }
 *     responses:
 *       201: { description: Logged }
 *       400: { description: Bad request }
 *       401: { description: Invalid activity key }
 *       500: { description: Server error }
 */
router.post('/track', trackActivity);

/**
 * @openapi
 * /activity:
 *   get:
 *     summary: Get activity logs (role-based)
 *     description: |
 *       Role 1: all logs (filters allowed)
 *       Role 2: only own company
 *       Role 3/4: only own ship
 *     tags: [Activity]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: company_id
 *         required: false
 *         schema: { type: string, format: uuid }
 *         description: Filter by company (role 1 only)
 *       - in: query
 *         name: ship_id
 *         required: false
 *         schema: { type: integer }
 *         description: Filter by ship (role 1 only)
 *       - in: query
 *         name: username
 *         required: false
 *         schema: { type: string }
 *         description: Filter by username (role 1 only)
 *       - in: query
 *         name: limit
 *         required: false
 *         schema: { type: integer, example: 100 }
 *     responses:
 *       200: { description: OK }
 *       401: { description: Unauthorized }
 *       500: { description: Server error }
 */
router.get('/', requireAuth, getActivityLogs);
