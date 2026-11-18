import express from "express";
import { requireAuth } from "../middleware/requireAuth.js";
import {
    acceptDisclaimer,
    getDisclaimerAcceptances
} from "../controller/disclaimerController.js"


const router = express.Router();

// User accepts disclaimer
router.post(
    "/accept",requireAuth,
    acceptDisclaimer
);

// Role 1 only - view all disclaimer acceptance records
router.get(
    "/acceptances",requireAuth,
    getDisclaimerAcceptances
);

export default router;