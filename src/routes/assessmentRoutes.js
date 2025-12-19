import { Router } from 'express';
import { requireAuth } from '../middleware/requireAuth.js';
import { allowRoles } from '../middleware/rbac.js';
import {
  getAllAssessments,
  getAssessmentById,
  createAssessment,
  updateAssessment,
  deleteAssessment,
} from '../controller/assessmentsController.js';

export const router = Router();
router.use(requireAuth);

router.get('/', allowRoles(1,2,3,4), getAllAssessments);
router.get('/:id', allowRoles(1,2,3,4), getAssessmentById);

router.post('/', allowRoles(1,2,3), createAssessment);
router.put('/:id', allowRoles(1,2,3), updateAssessment);
router.delete('/:id', allowRoles(1,2,3), deleteAssessment);
