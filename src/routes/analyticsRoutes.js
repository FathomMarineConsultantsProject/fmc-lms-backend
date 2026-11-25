
import { Router } from "express";

import { requireAuth } from "../middleware/requireAuth.js";
import { allowRoles } from "../middleware/rbac.js";

import {
    // Certificate Analytics
    getCertificateOverviewAnalytics,
    getCertificateRenewalAnalytics,
    getCrewCertificateAnalytics,
    getCertificateComplianceAnalytics,

    // Assessment Analytics
    getAssessmentOverviewAnalytics,
    getAssessmentPerformanceAnalytics,
    getAssessmentAssignmentAnalytics,

    // Training Analytics
    getTrainingOverviewAnalytics,
    getTrainingPerformanceAnalytics,
    getTrainingAssignmentAnalytics,

    // Combined Analytics
    getExecutiveCombinedAnalytics,
    getCompanyCombinedAnalytics,
    getFleetCombinedAnalytics,
    getSeafarerCombinedAnalytics,
    getSeafarerCompetencyPassport,
} from "../controller/analyticsController.js";

export const router = Router();

// =====================================================
// GLOBAL AUTHENTICATION & AUTHORIZATION
// =====================================================

// All routes require authentication
router.use(requireAuth);

// Only Super Admin (1) and Company Admin (2)
router.use(allowRoles(1, 2));

// =====================================================
// 1. CERTIFICATE ANALYTICS - 4 APIs
// =====================================================

// 1.1 Certificate Overview
router.get(
    "/certificates/overview",
    getCertificateOverviewAnalytics
);

// 1.2 Certificate Renewals
router.get(
    "/certificates/renewals",
    getCertificateRenewalAnalytics
);

// 1.3 Crew Certificate Analytics
router.get(
    "/certificates/crew",
    getCrewCertificateAnalytics
);

// 1.4 Certificate Compliance
router.get(
    "/certificates/compliance",
    getCertificateComplianceAnalytics
);

// =====================================================
// 2. ASSESSMENT ANALYTICS - 3 APIs
// =====================================================

// 2.1 Assessment Overview
router.get(
    "/assessments/overview",
    getAssessmentOverviewAnalytics
);

// 2.2 Assessment Performance
router.get(
    "/assessments/performance",
    getAssessmentPerformanceAnalytics
);

// 2.3 Assessment Assignments
router.get(
    "/assessments/assignments",
    getAssessmentAssignmentAnalytics
);

// =====================================================
// 3. TRAINING ANALYTICS - 3 APIs
// =====================================================

// 3.1 Learning Overview and Lifecycle
router.get(
    "/training/overview",
    getTrainingOverviewAnalytics
);

// 3.2 Training Performance and Programme Register
router.get(
    "/training/performance",
    getTrainingPerformanceAnalytics
);

// 3.3 Ship-wise Training Assignments
router.get(
    "/training/assignments",
    getTrainingAssignmentAnalytics
);

// =====================================================
// 4. EXECUTIVE ANALYTICS - 1 API
// =====================================================

// Includes:
// - Executive KPIs
// - Training and Assessment Trends
// - Crew Readiness
// - Competency Category Gaps
router.get(
    "/executive/combined",
    getExecutiveCombinedAnalytics
);

// =====================================================
// 5. COMPANY ANALYTICS - 1 API
// =====================================================

// Includes:
// - Company Performance
// - Company-wise Comparison
// - Fleet Composition
// - Company Readiness and Competency Summary
router.get(
    "/companies/combined",
    getCompanyCombinedAnalytics
);

// =====================================================
// 6. FLEET AND VESSEL ANALYTICS - 1 API
// =====================================================

// Includes:
// - Fleet Overview
// - Vessel Performance
// - Ship-wise Crew Distribution
// - Vessel Readiness
// - Ship-wise Competency
router.get(
    "/ships/combined",
    getFleetCombinedAnalytics
);

// =====================================================
// 7. SEAFARER ANALYTICS - 1 API
// =====================================================

// Includes:
// - Crew Overview
// - Training and Assessment Performance
// - Certificate Position
// - Competency and Readiness Scores
router.get(
    "/seafarers/combined",
    getSeafarerCombinedAnalytics
);

// =====================================================
// 8. INDIVIDUAL COMPETENCY PASSPORT - 1 API
// =====================================================

// Includes:
// - Seafarer Profile
// - Training History
// - Assessment History
// - Certificate History
// - 12 Competency Categories
// - Readiness Score and Status
// - Ship Assignment History
router.get(
    "/seafarers/:userId/passport",
    getSeafarerCompetencyPassport
);
