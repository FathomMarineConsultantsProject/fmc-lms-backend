// src/routes/companyRoutes.js
import { Router } from 'express';
import { requireAuth } from '../middleware/requireAuth.js';
import {
  getAllCompanies,
  getCompanyById,
  createCompany,
  updateCompany,
  deleteCompany,
} from '../controller/companyController.js';

export const router = Router();

router.use(requireAuth);

router.get('/', getAllCompanies);
router.get('/:id', getCompanyById);
router.post('/', createCompany);
router.put('/:id', updateCompany);
router.delete('/:id', deleteCompany);
