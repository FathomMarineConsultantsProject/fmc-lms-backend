import express from 'express';
import * as competancyController from '../controller/competancyController.js'; 
import { requireAuth } from "../middleware/requireAuth.js";
import { allowRoles } from "../middleware/rbac.js";
import { getExecutiveDashboard,getVesselReadinessBreakdown, getSeafarersByStatus, getUserClearanceStatus } from '../controller/competancyController.js';
const router = express.Router();

router.use(requireAuth);

// my competancy matrix
router.get('/my-matrix', competancyController.getMyCompetancyMatrix);
router.get('/dashboard', allowRoles(1, 2, 3), getExecutiveDashboard);
router.get('/vessels', allowRoles(1, 2, 3), getVesselReadinessBreakdown);
router.get('/seafarers', allowRoles(1, 2, 3), getSeafarersByStatus);
router.get('/clearance/:user_id', allowRoles(1, 2, 3, 4), getUserClearanceStatus);

// get all matrices
router.get('/', allowRoles(1,2,3), competancyController.getAllCompetancyMatrices);

// get user specific competancy
router.get('/user/:user_id',
    allowRoles(1,2,3),
    competancyController.getUserCompetancyMatrixById
);

export default router;