// src/routes/authRoutes.js
import { Router } from 'express';
import { login, changePassword } from '../controller/authController.js';

export const router = Router();

router.post('/login', login);
router.post('/change-password', changePassword);
