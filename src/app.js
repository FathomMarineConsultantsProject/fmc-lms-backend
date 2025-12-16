// src/app.js
import express from 'express';
import cors from 'cors';
import { router as companyRoutes } from './routes/companyRoutes.js';
import { router as shipRoutes } from './routes/shipRoutes.js';
import { router as userRoutes } from './routes/userRoutes.js';
// import { router as incidentRoutes } from './routes/incidentRoutes.js';


const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());

// simple health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'FMC backend running' });
});

// main routes
app.use('/companies', companyRoutes);
app.use('/ships', shipRoutes);
app.use('/users', userRoutes);
// app.use('/incidents', incidentRoutes);

app.listen(PORT, () => {
  console.log(`FMC backend listening on http://localhost:${PORT}`);
});
