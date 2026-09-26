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
  allowRoles("super_admin"),
  getSubscriptionRequests
);

// Get subscription of a specific company
router.get(
  "/admin/company/:companyId",
  requireAuth,
  allowRoles("super_admin"),
  getCompanySubscription
);

// Create subscription for a company
router.post(
  "/admin",
  requireAuth,
  allowRoles("super_admin"),
  createSubscription
);

// Approve subscription request
router.post(
  "/admin/requests/:requestId/approve",
  requireAuth,
  allowRoles("super_admin"),
  approveSubscriptionRequest
);

// Reject subscription request
router.post(
  "/admin/requests/:requestId/reject",
  requireAuth,
  allowRoles("super_admin"),
  rejectSubscriptionRequest
);

// Update / extend subscription
router.put(
  "/admin/:subscriptionId",
  requireAuth,
  allowRoles("super_admin"),
  updateSubscription
);

export default router;