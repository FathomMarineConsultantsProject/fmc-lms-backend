import express from 'express';

import { 
    getAllScenarios, 
    createScenario, 
    updateScenario, 
    getAllEquipment, 
    createEquipment, 
    updateEquipmentStatus, 
    updateEquipmentDetails 
} from '../controller/immersiveController.js';
import { requireAuth } from "../middleware/requireAuth.js";
import { allowRoles } from '../middleware/rbac.js';
export const router = express.Router();
// ==========================================
// SCENARIOS ROUTES
// ==========================================

// Public / All Authenticated Users (Assuming your main auth middleware is applied in server.js)
router.get('/scenarios',requireAuth, getAllScenarios);

// Protected (SuperAdmin: 1 & Admin: 2 only)
router.post('/scenarios',requireAuth, allowRoles(1, 2), createScenario);
router.patch('/scenarios/:id',requireAuth, allowRoles(1, 2), updateScenario);

// ==========================================
// EQUIPMENT ROUTES
// ==========================================

// Public / All Authenticated Users
router.get('/equipment',requireAuth,getAllEquipment);

// Protected (SuperAdmin: 1 & Admin: 2 only)
router.post('/equipment',requireAuth, allowRoles(1, 2), createEquipment);
router.patch('/equipment/:id/status',requireAuth, allowRoles(1, 2), updateEquipmentStatus);
router.patch('/equipment/:id',requireAuth, allowRoles(1, 2), updateEquipmentDetails);

