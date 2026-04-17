import { Router } from "express";
import { requireAuth } from "../middleware/requireAuth.js";
import { allowRoles } from "../middleware/rbac.js";
import {
  issueCertificate,
  generateCertificate,
  filterCertificates,
  getMyCertificates,
  getCertificatesByUserId,
  getCertificateById,
  getUserInfoForCertificate,
} from "../controller/certificatesController.js";

export const router = Router();

router.use(requireAuth);

// admin/instructor creates certificate issue setup
router.post("/issue", allowRoles(1, 2, 3), issueCertificate);

// eligible user generates own certificate after completion
router.post("/generate", allowRoles(1, 2, 3, 4), generateCertificate);

// filter generated certificates
router.post("/filter", allowRoles(1, 2, 3, 4), filterCertificates);

// read APIs
router.get("/my", allowRoles(1, 2, 3, 4), getMyCertificates);
router.get("/user/:userId", allowRoles(1, 2, 3), getCertificatesByUserId);
router.get("/:id", allowRoles(1, 2, 3, 4), getCertificateById);

// unity lookup
router.post("/user-info", allowRoles(1, 2, 3, 4), getUserInfoForCertificate);