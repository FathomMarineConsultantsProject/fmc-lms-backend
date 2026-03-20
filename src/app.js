// src/app.js
import express from 'express';
import cors from 'cors';
import swaggerUi from "swagger-ui-express";
import swaggerSpec from "./swagger.js";

import { router as companyRoutes } from './routes/companyRoutes.js';
import { router as shipRoutes } from './routes/shipRoutes.js';
import { router as userRoutes } from './routes/userRoutes.js';
import { router as authRoutes } from './routes/authRoutes.js';
import { router as incidentRoutes } from './routes/incidentRoutes.js';
import { router as certificateRoutes } from './routes/certificateRoutes.js';
import { router as assessmentRoutes } from './routes/assessmentRoutes.js';
import { router as activityRoutes } from './routes/activityRoutes.js';


const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());
app.use("/docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec));
app.get("/openapi.json", (req, res) => res.json(swaggerSpec));

// simple health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'FMC backend running' });
});

// main routes
app.use('/auth', authRoutes);
app.use('/companies', companyRoutes);
app.use('/ships', shipRoutes);
app.use('/users', userRoutes);
app.use('/incidents', incidentRoutes);
app.use('/certificates', certificateRoutes);
app.use('/assessments', assessmentRoutes);
app.use('/activity', activityRoutes);


app.listen(PORT, () => {
  console.log(`FMC backend listening on http://localhost:${PORT}`);
});
