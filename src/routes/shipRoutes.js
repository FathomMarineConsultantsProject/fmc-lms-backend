// src/routes/shipRoutes.js
import { Router } from 'express';
import {
  getAllShips,
  getShipById,
  createShip,
  updateShip,
  deleteShip,
} from '../controller/shipsController.js';

export const router = Router();

// Routes are now thin: just mapping URL -> controller
router.get('/', getAllShips);
router.get('/:id', getShipById);
router.post('/', createShip);
router.put('/:id', updateShip);
router.delete('/:id', deleteShip);
