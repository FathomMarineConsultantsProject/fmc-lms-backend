// src/routes/deviceRoutes.js
import { Router } from "express";
import { setDeviceId, getDeviceId } from "../controller/deviceController.js";

export const router = Router();

// Unity calls (protected by X-Device-Key header)
router.post("/set", setDeviceId);
router.post("/get", getDeviceId);
