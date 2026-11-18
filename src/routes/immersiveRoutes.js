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

export const router = express.Router();

// ==========================================
// SCENARIOS ROUTES
// ==========================================

// Public to all authenticated users
router.get('/scenarios', requireAuth, getAllScenarios);

// Protected (Admin check happens in the controller now)
router.post('/scenarios', requireAuth, createScenario);
router.patch('/scenarios/:id', requireAuth, updateScenario);

// ==========================================
// EQUIPMENT ROUTES
// ==========================================

// Public to all authenticated users
router.get('/equipment', requireAuth, getAllEquipment);

// Protected (Admin check happens in the controller now)
router.post('/equipment', requireAuth, createEquipment);
router.patch('/equipment/:id/status', requireAuth, updateEquipmentStatus);
router.patch('/equipment/:id', requireAuth, updateEquipmentDetails);