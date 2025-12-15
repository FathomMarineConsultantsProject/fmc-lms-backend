// src/routes/companyRoutes.js
import { Router } from 'express';
import {
  getAllCompanies,
  getCompanyById,
  createCompany,
  updateCompany,
  deleteCompany,
} from '../controller/companyController.js';

export const router = Router();

router.get('/', getAllCompanies);  // get/ companies
router.get('/:id', getCompanyById); // get/ companies/:id
router.post('/', createCompany);
router.put('/:id', updateCompany);
router.delete('/:id', deleteCompany);
