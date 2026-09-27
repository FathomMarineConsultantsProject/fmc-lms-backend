// src/routes/subscriptionRoutes.js

import { Router } from "express";

import {
  getSubscriptionStatus,
  getMySubscription,
  requestSubscription,
  getMySubscriptionRequest,
  getSubscriptionRequests,
  getCompanySubscription,
  createSubscription,
  approveSubscriptionRequest,
  rejectSubscriptionRequest,
  updateSubscription,
} from "../controller/subscriptionController.js";

import { requireAuth } from "../middleware/requireAuth.js";
import { allowRoles } from "../middleware/rbac.js";

const router = Router();

// =========================================================
// COMPANY / USER ROUTES
// =========================================================

// Check whether company's subscription is active
router.get(
  "/status",
  requireAuth,
  getSubscriptionStatus
);

// Get current company's subscription
router.get(
  "/my",
  requireAuth,
  getMySubscription
);

// Request subscription / re-subscription
router.post(
  "/request",
  requireAuth,
  requestSubscription
);

// Get latest subscription request for current company
router.get(
  "/request",
  requireAuth,
  getMySubscriptionRequest
);

// =========================================================
// SUPER ADMIN ROUTES
// =========================================================

// Get all subscription requests
// Optional: ?status=pending
router.get(
  "/admin/requests",
  requireAuth,
  allowRoles(1),
  getSubscriptionRequests
);

// Get subscription of a specific company
router.get(
  "/admin/company/:companyId",
  requireAuth,
  allowRoles(1),
  getCompanySubscription
);

// Create subscription for a company
router.post(
  "/admin",
  requireAuth,
  allowRoles(1),
  createSubscription
);

// Approve subscription request
router.post(
  "/admin/requests/:requestId/approve",
  requireAuth,
  allowRoles(1),
  approveSubscriptionRequest
);

// Reject subscription request
router.post(
  "/admin/requests/:requestId/reject",
  requireAuth,
  allowRoles(1),
  rejectSubscriptionRequest
);

// Update / extend subscription
router.put(
  "/admin/:subscriptionId",
  requireAuth,
  allowRoles(1),
  updateSubscription
);

export default router;