// src/routes/meetingRoutes.js
import { Router } from "express";
import { requireAuth } from "../middleware/requireAuth.js";
import { allowRoles } from "../middleware/rbac.js";
import {
  createMeeting,
  queryMeetings,
  getMeetingById,
  updateMeeting,
  deleteMeeting,
  sendMeetingEmails,
} from "../controller/meetingController.js";

export const router = Router();

/**
 * Meetings RBAC suggestion:
 * - Superadmin (1): all
 * - Admin (2): company scope
 * - Subadmin (3): company+ship scope
 * - Crew (4): usually read-only (optional)
 */
const ADMIN_ROLES = [1, 2, 3, 4];
const READ_ROLES = [1, 2, 3, 4];

/**
 * @openapi
 * /meetings:
 *   post:
 *     summary: Create a meeting
 *     tags: [Meetings]
 *     security: [{ bearerAuth: [] }]
 */
router.post("/", requireAuth, allowRoles(...ADMIN_ROLES), createMeeting);

/**
 * @openapi
 * /meetings/query:
 *   post:
 *     summary: Query meetings (POST-based listing with filters)
 *     tags: [Meetings]
 *     security: [{ bearerAuth: [] }]
 */
router.post("/query", requireAuth, allowRoles(...READ_ROLES), queryMeetings);

/**
 * @openapi
 * /meetings/{meeting_id}:
 *   get:
 *     summary: Get meeting by id
 *     tags: [Meetings]
 *     security: [{ bearerAuth: [] }]
 */
router.get("/:meeting_id", requireAuth, allowRoles(...READ_ROLES), getMeetingById);

/**
 * @openapi
 * /meetings/{meeting_id}:
 *   patch:
 *     summary: Update meeting (meeting_id cannot change)
 *     tags: [Meetings]
 *     security: [{ bearerAuth: [] }]
 */
router.patch("/:meeting_id", requireAuth, allowRoles(...ADMIN_ROLES), updateMeeting);

/**
 * @openapi
 * /meetings/{meeting_id}:
 *   delete:
 *     summary: Delete meeting (soft delete)
 *     tags: [Meetings]
 *     security: [{ bearerAuth: [] }]
 */
router.delete("/:meeting_id", requireAuth, allowRoles(...ADMIN_ROLES), deleteMeeting);

/**
 * @openapi
 * /meetings/{meeting_id}/send-emails:
 *   post:
 *     summary: Send meeting email invitations manually
 *     tags: [Meetings]
 *     security: [{ bearerAuth: [] }]
 */
router.post(
  "/:meeting_id/send-emails",
  requireAuth,
  allowRoles(...ADMIN_ROLES),
  sendMeetingEmails
);