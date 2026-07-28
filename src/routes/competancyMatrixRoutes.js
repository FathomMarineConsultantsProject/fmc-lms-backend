import express from 'express';
import * as competancyController from '../controller/competancyController.js'; 
import { requireAuth } from "../middleware/requireAuth.js";
import { allowRoles } from "../middleware/rbac.js";

const router = express.Router();

router.use(requireAuth);

// my competancy matrix
router.get('/my-matrix', competancyController.getMyCompetancyMatrix);

// get all matrices
router.get('/', allowRoles(1,2,3), competancyController.getAllCompetancyMatrices);

// get user specific competancy
router.get('/user/:user_id',
    allowRoles(1,2,3),
    competancyController.getUserCompetancyMatrixById
);

export default router;