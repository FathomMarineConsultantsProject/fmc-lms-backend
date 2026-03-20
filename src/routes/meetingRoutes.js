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

// Everyone can create/read
const CREATE_ROLES = [1, 2, 3, 4];
const READ_ROLES = [1, 2, 3, 4];

// Keep edit/delete stricter if you want
const MANAGE_ROLES = [1, 2, 3];

/**
 * Create
 */
router.post("/", requireAuth, allowRoles(...CREATE_ROLES), createMeeting);

/**
 * Query/list
 */
router.post("/query", requireAuth, allowRoles(...READ_ROLES), queryMeetings);

/**
 * Get by id
 */
router.get("/:meeting_id", requireAuth, allowRoles(...READ_ROLES), getMeetingById);

/**
 * Update
 */
router.patch("/:meeting_id", requireAuth, allowRoles(...MANAGE_ROLES), updateMeeting);

/**
 * Delete
 */
router.delete("/:meeting_id", requireAuth, allowRoles(...MANAGE_ROLES), deleteMeeting);

/**
 * Manual email send
 */
router.post(
  "/:meeting_id/send-emails",
  requireAuth,
  allowRoles(...MANAGE_ROLES),
  sendMeetingEmails
);