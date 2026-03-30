import pg from "pg";
import dotenv from "dotenv";
dotenv.config();

const { Pool } = pg;

const useSSL =
  process.env.PG_SSL === "true" ||
  process.env.NODE_ENV === "production" ||
  !!process.env.VERCEL;

console.log("DB host:", process.env.PG_HOST);
console.log("DB SSL enabled:", useSSL);

export const db = new Pool({
  host: process.env.PG_HOST,
  port: Number(process.env.PG_PORT || 5432),
  user: process.env.PG_USER,
  password: process.env.PG_PASSWORD,
  database: process.env.PG_DATABASE,
  ssl: useSSL ? { rejectUnauthorized: false } : false,
});