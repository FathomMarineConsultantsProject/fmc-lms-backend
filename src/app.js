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
import {router as chatRoutes} from "./routes/chatRoutes.js"
import assessmentRoutes from "./routes/assessmentRoutes.js";
import { router as activityRoutes } from "./routes/activityRoutes.js";
import mailTestRoutes from "./routes/mailTestRoutes.js";
import userMailRoutes from "./routes/userMailRoutes.js";
import userExportRoutes from "./routes/userExportRoutes.js";
import { router as deviceRoutes } from "./routes/deviceRoutes.js";
import { router as meetingRoutes } from "./routes/meetingRoutes.js";
import { router as integrationRoutes } from "./routes/integrationRoutes.js";
import courseRoutes from "./routes/courseRoutes.js";
import unityCourseRoutes from './routes/unityCourseRoutes.js';
import competancyRoutes from './routes/competancyMatrixRoutes.js'
import aiAssistant from './routes/aiRoutes.js'

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
  allowedHeaders: [
  "Content-Type",
  "Authorization",

  // Existing activity/device API headers
  "X-Activity-Key",
  "ACTIVITY_API_KEY",
  "X-Device-Key",

  // Unity course progress API headers
  "X-Unity-Course-Key",
  "UNITY_COURSE_API_KEY",
  "Unity-Course-API-Key",
],
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
app.use("/api/courses", courseRoutes);
app.use('/api/matrix',competancyRoutes);
//meeting integrations
app.use("/integrations", integrationRoutes);

//chat 
app.use("/chat", chatRoutes);
//chatbot
app.use("/ai", aiAssistant);
// actual credential mail APIs
app.use("/api/users", userMailRoutes);
app.use("/api/users", userExportRoutes);
app.use("/device", deviceRoutes);
// testing
app.use("/api/mail", mailTestRoutes);

/**
 * Unity course progress APIs
 *
 * POST /unity-courses/progress/track
 * - Unity app sends course progress here.
 * - Protected by UNITY_COURSE_API_KEY.
 *
 * GET /unity-courses/progress
 * - Dashboard/admin reads stored Unity course progress.
 * - Protected by normal login token.
 */
app.use('/unity-courses', unityCourseRoutes);

// ✅ CORS error handler MUST be after cors()
app.use((err, req, res, next) => {
  if (err?.message?.startsWith("Not allowed by CORS")) {
    return res.status(403).json({ error: err.message });
  }
  next(err);
});

export default app; // vercel important
// const PORT = process.env.PORT || 4000;
// app.listen(PORT, () => {
//   console.log(`FMC backend listening on http://localhost:${PORT}`);
// });
