// src/routes/shipRoutes.js
import { Router } from 'express';
import { requireAuth } from '../middleware/requireAuth.js';
import {
  getAllShips,
  getShipById,
  createShip,
  updateShip,
  deleteShip,
} from '../controller/shipsController.js';

export const router = Router();

router.use(requireAuth);

router.get('/', getAllShips); // GET /ships
router.get('/:id', getShipById); // GET /ships/:id
router.post('/', createShip);
router.put('/:id', updateShip);
router.delete('/:id', deleteShip);
