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
} from "../controller/coursesController.js";

const router = express.Router();

router.post("/", requireAuth, createCourse);
router.get("/", requireAuth, getCourses);

router.get("/enrolled/:userId", requireAuth, getCoursesByUserId);
router.get("/media/:mediaFileId/url", requireAuth, getCourseContentMediaSignedUrl);

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

router.get("/:id", requireAuth, getCourseById);
router.put("/:id", requireAuth, updateCourse);
router.delete("/:id", requireAuth, deleteCourse);

export default router;