// src/routes/unityCourseRoutes.js
import express from 'express';

// This GET API is for dashboard/admin side, so it uses normal login auth.
// Keep this import same as your current project.
// If your requireAuth is default export, change this to:
// import requireAuth from '../middleware/requireAuth.js';
import { requireAuth } from '../middleware/requireAuth.js';

import {
  trackUnityCourseProgress,
  getUnityCourseProgress,
} from '../controller/unityCourseController.js';

const router = express.Router();

/**
 * API 1: UNITY COURSE PROGRESS POST API
 * -------------------------------------
 * Endpoint:
 * POST /unity-courses/progress/track
 *
 * Who calls this?
 * Unity app / Unity developer.
 *
 * Purpose:
 * Unity sends course progress data whenever a user starts, updates,
 * or completes a Unity course.
 *
 * Security:
 * Protected using UNITY_COURSE_API_KEY header.
 *
 * Example body:
 * {
 *   "user_id": 2110,
 *   "unity_course_code": "FIRE_SAFETY",
 *   "course_name": "Fire Safety Training",
 *   "progress_percentage": 80,
 *   "is_completed": false,
 *   "started_at": "2026-05-14-10:00",
 *   "last_activity_at": "2026-05-14-10:45"
 * }
 */
router.post('/progress/track', trackUnityCourseProgress);

/**
 * API 2: UNITY COURSE PROGRESS GET API
 * ------------------------------------
 * Endpoint:
 * GET /unity-courses/progress
 *
 * Who calls this?
 * Admin dashboard / frontend / backend reporting screen.
 *
 * Purpose:
 * Returns all stored Unity course progress data with:
 * - user_id
 * - username
 * - seafarer_id
 * - full_name
 * - rank
 * - company
 * - ship
 * - course name
 * - progress percentage
 * - completed status
 * - started/completed/last activity time
 *
 * Security:
 * Protected using normal login token through requireAuth.
 *
 * Example filters:
 * GET /unity-courses/progress?rank=MASTER
 * GET /unity-courses/progress?ship_id=5
 * GET /unity-courses/progress?company_id=abc
 * GET /unity-courses/progress?course_code=FIRE_SAFETY
 * GET /unity-courses/progress?completed=true
 * GET /unity-courses/progress?search=thanabalan
 */
router.get('/progress', requireAuth, getUnityCourseProgress);

export default router;