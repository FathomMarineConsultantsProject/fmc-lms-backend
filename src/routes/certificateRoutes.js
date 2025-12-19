import { Router } from 'express';
import { requireAuth } from '../middleware/requireAuth.js';
import { allowRoles } from '../middleware/rbac.js';
import {
  getAllCertificates,
  getCertificateById,
  createCertificate,
  updateCertificate,
  deleteCertificate,
} from '../controller/certificatesController.js';

export const router = Router();
router.use(requireAuth);

router.get('/', allowRoles(1,2,3,4), getAllCertificates);
router.get('/:id', allowRoles(1,2,3,4), getCertificateById);

router.post('/', allowRoles(1,2,3), createCertificate);
router.put('/:id', allowRoles(1,2,3), updateCertificate);
router.delete('/:id', allowRoles(1,2,3), deleteCertificate);
