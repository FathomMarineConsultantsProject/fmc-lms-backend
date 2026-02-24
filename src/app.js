// src/app.js
import express from "express";
import cors from "cors";
import swaggerUi from "swagger-ui-express";
import swaggerSpec from "./swagger.js";
import { requireHttps } from "./middleware/requireHttps.js";

import { router as companyRoutes } from "./routes/companyRoutes.js";
import { router as shipRoutes } from "./routes/shipRoutes.js";
import { router as userRoutes } from "./routes/userRoutes.js";
import { router as authRoutes } from "./routes/authRoutes.js";
import { router as incidentRoutes } from "./routes/incidentRoutes.js";
import { router as certificateRoutes } from "./routes/certificateRoutes.js";
import { router as assessmentRoutes } from "./routes/assessmentRoutes.js";
import { router as activityRoutes } from "./routes/activityRoutes.js";
import mailTestRoutes from "./routes/mailTestRoutes.js";
import userMailRoutes from "./routes/userMailRoutes.js";
import userExportRoutes from "./routes/userExportRoutes.js";
import { router as deviceRoutes } from "./routes/deviceRoutes.js";
import { router as meetingRoutes } from "./routes/meetingRoutes.js";

const app = express();

app.set("trust proxy", 1);

// --- CORS (MUST be first, before requireHttps/routes) ---
const allowedExactOrigins = new Set([
  "https://fmc-admin-dashboard-frontend.vercel.app",
  "http://localhost:3000",
  "http://localhost:5173",
]);

// Allow Vercel preview deployments for THIS frontend project:
// e.g. https://fmc-admin-dashboard-frontend-git-main-xxxx.vercel.app
const vercelPreviewRegex = /^https:\/\/fmc-admin-dashboard-frontend(-[a-z0-9-]+)?\.vercel\.app$/i;

const corsOptions = {
  origin(origin, cb) {  
    // no origin = Postman / server-to-server / same-machine tools
    if (!origin) return cb(null, true);

    if (allowedExactOrigins.has(origin)) return cb(null, true);
    if (vercelPreviewRegex.test(origin)) return cb(null, true);

    return cb(new Error(`Not allowed by CORS: ${origin}`));
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-Activity-Key" , "X-Device-Key"],
  optionsSuccessStatus: 204,
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

// Now enforce https for real requests
app.use(requireHttps);

app.use(express.json());

// Swagger
app.use("/docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec));
app.get("/openapi.json", (req, res) => res.json(swaggerSpec));

// Health
app.get("/", (req, res) => {
  res.json({ status: "ok", message: "FMC backend running" });
});

// main routes
app.use("/auth", authRoutes);
app.use("/companies", companyRoutes);
app.use("/ships", shipRoutes);
app.use("/users", userRoutes);
app.use("/incidents", incidentRoutes);
app.use("/certificates", certificateRoutes);
app.use("/assessments", assessmentRoutes);
app.use("/activity", activityRoutes);
app.use("/meetings", meetingRoutes);

// actual credential mail APIs
app.use("/api/users", userMailRoutes);
app.use("/api/users", userExportRoutes);
app.use("/device", deviceRoutes);
// testing
app.use("/api/mail", mailTestRoutes);

// ✅ CORS error handler MUST be after cors()
app.use((err, req, res, next) => {
  if (err?.message?.startsWith("Not allowed by CORS")) {
    return res.status(403).json({ error: err.message });
  }
  next(err);
});

export default app; // vercel important

// app.listen(PORT, () => {
//   console.log(`FMC backend listening on http://localhost:${PORT}`);
// });
