import express from "express";

import {
    acceptDisclaimer,
    getDisclaimerAcceptances
} from "../controllers/disclaimerController.js";


const router = express.Router();

// User accepts disclaimer
router.post(
    "/accept",
    acceptDisclaimer
);

// Role 1 only - view all disclaimer acceptance records
router.get(
    "/acceptances",
    getDisclaimerAcceptances
);

export default router;