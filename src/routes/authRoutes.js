import { Router } from 'express';
import { login } from '../controller/authController.js';

export const router = Router();
router.post('/login', login);
