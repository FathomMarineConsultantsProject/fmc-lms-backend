import express from "express";
import { requireAuth } from "../middleware/requireAuth.js";
import {
  createCourse,
  getCourses,
  getCourseById,
  getCoursesByUserId,
  updateCourse,
  deleteCourse,
} from "../controller/coursesController.js";

const router = express.Router();

router.post("/", requireAuth, createCourse);
router.get("/", requireAuth, getCourses);
router.get("/enrolled/:userId", requireAuth, getCoursesByUserId);
router.get("/:id", requireAuth, getCourseById);
router.put("/:id", requireAuth, updateCourse);
router.delete("/:id", requireAuth, deleteCourse);

export default router;