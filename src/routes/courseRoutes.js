import express from "express";
import { requireAuth } from "../middleware/requireAuth.js";
import { uploadCourseFiles } from "../middleware/uploadCourseFiles.js";
import {
  createCourse,
  getCourses,
  getCourseById,
  getCoursesByUserId,
  updateCourse,
  deleteCourse,
  uploadCourseContentMedia,
  getCourseContentMediaSignedUrl,
  deleteCourseContentMedia,
  getCourseContentById,
  getCourseContentMedia,
  deleteCourseContent,
  createCourseContent,
  updateCourseContent,
  getCourseContentMediaById,
  replaceCourseContentMedia,
  reorderCourseContents,
  completeCourseByLoggedInUser,
  getMyCourseCompletionStatus,
  getMyCompletedCourses,
  assignCourseToUsers,
  getMyAssignedCourses,
  getMyCompletedAssignedCourses,
  assignCourseToShips

} from "../controller/coursesController.js";

const router = express.Router();

router.post("/", requireAuth, createCourse);
router.get("/", requireAuth, getCourses);

router.get("/enrolled/:userId", requireAuth, getCoursesByUserId);
router.get("/media/:mediaFileId/url", requireAuth, getCourseContentMediaSignedUrl);

// logged-in user completion routes
router.post(
  "/:courseId/complete",
  requireAuth,
  completeCourseByLoggedInUser
);

router.get(
  "/:courseId/completion-status",
  requireAuth,
  getMyCourseCompletionStatus
);

router.get(
  "/completed/me",
  requireAuth,
  getMyCompletedCourses
);

// GET /api/courses/my-assigned
router.get('/my-assigned', requireAuth, getMyAssignedCourses);

// GET /api/courses/my-assigned-completed
router.get('/my-assigned-completed', requireAuth, getMyCompletedAssignedCourses);

router.get(
  "/:courseId/contents/:contentId",
  requireAuth,
  getCourseContentById
);

router.get(
  "/:courseId/contents/:contentId/media",
  requireAuth,
  getCourseContentMedia
);

router.delete(
  "/:courseId/contents/:contentId",
  requireAuth,
  deleteCourseContent
);

router.post(
  "/:courseId/contents/:contentId/media",
  requireAuth,
  uploadCourseFiles.array("files", 10),
  uploadCourseContentMedia
);

router.delete(
  "/:courseId/contents/:contentId/media/:mediaFileId",
  requireAuth,
  deleteCourseContentMedia
);

// create module
router.post(
  "/:courseId/contents",
  requireAuth,
  createCourseContent
);

// update module
router.put(
  "/:courseId/contents/:contentId",
  requireAuth,
  updateCourseContent
);

// reorder modules
router.patch(
  "/:courseId/contents/reorder",
  requireAuth,
  reorderCourseContents
);

// get single media
router.get(
  "/:courseId/contents/:contentId/media/:mediaFileId",
  requireAuth,
  getCourseContentMediaById
);

// replace media
router.put(
  "/:courseId/contents/:contentId/media/:mediaFileId",
  requireAuth,
  uploadCourseFiles.single("file"),
  replaceCourseContentMedia
);

router.get("/:id", requireAuth, getCourseById);
router.put("/:id", requireAuth, updateCourse);
router.delete("/:id", requireAuth, deleteCourse);


//assign courses
router.post(
    '/:courseId/assign', 
    requireAuth,
    assignCourseToUsers
);

router.post(
    '/:courseId/assign-to-ships', 
    requireAuth,
    assignCourseToShips
);

export default router;


// ======================= COURSE MANAGEMENT =======================

// Course CRUD
// POST   /api/courses
// GET    /api/courses
// GET    /api/courses/:id
// PUT    /api/courses/:id
// DELETE /api/courses/:id

// Enrollments / completion
// GET    /api/courses/enrolled/:userId
// POST   /api/courses/:courseId/complete
// GET    /api/courses/:courseId/completion-status
// GET    /api/courses/completed/me


// ======================= COURSE CONTENT (MODULES) =======================

// Create module
// POST   /api/courses/:courseId/contents

// Get single module
// GET    /api/courses/:courseId/contents/:contentId

// Update module
// PUT    /api/courses/:courseId/contents/:contentId

// Delete module
// DELETE /api/courses/:courseId/contents/:contentId

// Reorder modules
// PATCH  /api/courses/:courseId/contents/reorder


// ======================= COURSE CONTENT MEDIA =======================

// Get all media in module
// GET    /api/courses/:courseId/contents/:contentId/media

// Get single media inside module
// GET    /api/courses/:courseId/contents/:contentId/media/:mediaFileId

// Upload media (multiple files)
// POST   /api/courses/:courseId/contents/:contentId/media

// Replace media file
// PUT    /api/courses/:courseId/contents/:contentId/media/:mediaFileId

// Delete media
// DELETE /api/courses/:courseId/contents/:contentId/media/:mediaFileId

// Get signed URL (direct access)
// GET    /api/courses/media/:mediaFileId/url