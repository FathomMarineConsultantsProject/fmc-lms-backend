import express from "express";

import {
    acceptDisclaimer,
    getDisclaimerAcceptances
} from "../controller/disclaimerController"


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