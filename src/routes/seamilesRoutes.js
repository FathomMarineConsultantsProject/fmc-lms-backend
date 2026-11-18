import { Router } from "express";
import { requireAuth } from "../middleware/requireAuth.js";
import { getMySeaMiles } from "../controller/seamilesController.js";

const router = Router();

router.use(requireAuth);

router.get("/balance", getMySeaMiles);

export default router;