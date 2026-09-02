const express = require('express');

import { 
    getAllScenarios, 
    createScenario, 
    updateScenario, 
    getAllEquipment, 
    createEquipment, 
    updateEquipmentStatus, 
    updateEquipmentDetails 
} from '../controllers/immersiveController.js';

import { allowRoles } from '../middleware/rbac';
export const router = express.Router();
// ==========================================
// SCENARIOS ROUTES
// ==========================================

// Public / All Authenticated Users (Assuming your main auth middleware is applied in server.js)
router.get('/scenarios', getAllScenarios);

// Protected (SuperAdmin: 1 & Admin: 2 only)
router.post('/scenarios', allowRoles(1, 2), createScenario);
router.patch('/scenarios/:id', allowRoles(1, 2), updateScenario);

// ==========================================
// EQUIPMENT ROUTES
// ==========================================

// Public / All Authenticated Users
router.get('/equipment',getAllEquipment);

// Protected (SuperAdmin: 1 & Admin: 2 only)
router.post('/equipment', allowRoles(1, 2), createEquipment);
router.patch('/equipment/:id/status', allowRoles(1, 2), updateEquipmentStatus);
router.patch('/equipment/:id', allowRoles(1, 2), updateEquipmentDetails);

