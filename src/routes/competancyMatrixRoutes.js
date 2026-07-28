const express = require('express');
const router = express.Router();

import competancyController from '../controller/competancyController';

import { requireAuth } from "../middleware/requireAuth.js";
import { allowRoles } from "../middleware/rbac.js";

const router = express.Router();

router.use(requireAuth);

//my competancy matrix
router.get('/my-matrix', competancyController.getMyCompetanceMatrix);

//get all matrices
router.get('/',allowRoles(1,2,3), competancyController.getAllCompetancyMatrices);


//get user specific competancy
router.get('/user/:id',
    allowRoles(1,2,3),
    competancyController.getUserCompetancyMatrixById
);
export default router;