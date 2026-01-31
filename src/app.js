// src/app.js
import express from 'express';
import cors from 'cors';
import swaggerUi from "swagger-ui-express";
import swaggerSpec from "./swagger.js";
import { requireHttps } from "./middleware/requireHttps.js";

import { router as companyRoutes } from './routes/companyRoutes.js';
import { router as shipRoutes } from './routes/shipRoutes.js';
import { router as userRoutes } from './routes/userRoutes.js';
import { router as authRoutes } from './routes/authRoutes.js';
import { router as incidentRoutes } from './routes/incidentRoutes.js';
import { router as certificateRoutes } from './routes/certificateRoutes.js';
import { router as assessmentRoutes } from './routes/assessmentRoutes.js';
import { router as activityRoutes } from './routes/activityRoutes.js';
import mailTestRoutes from "./routes/mailTestRoutes.js";
import userMailRoutes from "./routes/userMailRoutes.js";
import userExportRoutes from "./routes/userExportRoutes.js";

const app = express();
const PORT = process.env.PORT || 4000;
const allowedOrigins = [
  "https://fmc-admin-dashboard-frontend.vercel.app",
  "http://localhost:3000",
  "http://localhost:5173",
];

app.set("trust proxy", 1); // IMPORTANT for x-forwarded-* headers

// 1) CORS first (so preflight gets headers)
const corsOptions = {
  origin: function (origin, cb) {
    if (!origin) return cb(null, true); // Postman / server-to-server
    if (allowedOrigins.includes(origin)) return cb(null, true);
    return cb(new Error("Not allowed by CORS"));
  },
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true,
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

// 3) Now enforce https for real requests
app.use(requireHttps);
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
// actual credential mail APIs
app.use("/api/users", userMailRoutes);
app.use("/api/users", userExportRoutes);

// testing
app.use("/api/mail", mailTestRoutes);


export default app; // vercel important

// app.listen(PORT, () => {
//   console.log(`FMC backend listening on http://localhost:${PORT}`);
// });
