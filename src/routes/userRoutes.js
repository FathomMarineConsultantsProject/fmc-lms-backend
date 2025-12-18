// src/routes/userRoutes.js
import { Router } from 'express';
import { requireAuth } from '../middleware/requireAuth.js';

import {
  getAllUsers,
  getUserById,
  createUser,
  updateUser,
  deleteUser,
} from '../controller/usersController.js';

export const router = Router();

router.use(requireAuth);

router.get('/', getAllUsers);
router.get('/:id', getUserById);
router.post('/', createUser);
router.put('/:id', updateUser);
router.delete('/:id', deleteUser);
