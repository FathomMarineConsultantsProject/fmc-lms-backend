import pg from "pg";
import dotenv from "dotenv";
dotenv.config();

const { Pool } = pg;

export const pool = new Pool({
  host: process.env.PG_HOST,
  port: Number(process.env.PG_PORT || 5432),
  user: process.env.PG_USER,
  password: process.env.PG_PASSWORD,
  database: process.env.PG_DATABASE,

  // ✅ SSL for RDS (common fix for Vercel)
  ssl: process.env.PG_SSL === "true"
    ? { rejectUnauthorized: false }
    : false
});
