// src/controller/activityLogsController.js
import { db } from '../db.js';

// simple API key protection for Unity calls 
// Add ACTIVITY_API_KEY=some_secret in .env
const requireActivityKey = (req, res) => {
  const key =
    req.headers['x-activity-key'] ||
    req.headers['activity_api_key'] ||     // Postman might lowercase it
    req.headers['activity-api-key'];       // just in case

  const expected = process.env.ACTIVITY_API_KEY;
  if (!expected) return true;

  if (String(key || '') !== String(expected)) {
    res.status(401).json({ error: 'Invalid activity key' });
    return false;
  }
  return true;
};

// Parse "YYYY-MM-DD-HH:mm" into Date (fallback to now)
const parseUnityTimestamp = (s) => {
  if (!s) return null;
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})-(\d{2}):(\d{2})$/);
  if (!m) return null;
  const [_, Y, M, D, h, min] = m;
  // interpret as local server time; if you want UTC, use Date.UTC(...)
  return new Date(Number(Y), Number(M) - 1, Number(D), Number(h), Number(min), 0);
};

/**
 * POST /activity/track
 * Body example:
 * { "username":"user5008", "trainingType":"Training", "timestamp":"2025-12-24-09:28", "activityType":"login" }
 *
 * activityType optional: if missing, we'll store "training"
 */
export const trackActivity = async (req, res) => {
  if (!requireActivityKey(req, res)) return;

  const { username, trainingType, timestamp, activityType, ...rest } = req.body || {};
  if (!username) return res.status(400).json({ error: "username is required" });

  const occurredAt = parseUnityTimestamp(timestamp) || new Date();
  const finalActivityType = activityType || "training";

  try {
    // resolve user_id/company_id/ship_id from username
    const u = await db.query(
      `SELECT user_id, company_id, ship_id, role_id FROM users WHERE username = $1 LIMIT 1`,
      [String(username)]
    );
    const userRow = u.rows[0] || null;

    // (optional safety) if caller is logged-in crew, don’t allow logging for other users
    // If Unity won’t send Authorization header, this won’t run.
    if (req.user?.role_id && Number(req.user.role_id) === 4) {
      if (userRow?.user_id && Number(req.user.user_id) !== Number(userRow.user_id)) {
        return res.status(403).json({ error: "Crew can only log their own activity" });
      }
    }

    const insert = await db.query(
      `
      INSERT INTO activity_logs
        (user_id, username, company_id, ship_id, activity_type, training_type, payload_json, occurred_at)
      VALUES
        ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
      RETURNING
        activity_id,
        user_id,
        username,
        company_id,
        ship_id,
        activity_type,
        training_type,
        occurred_at,
        created_at
      `,
      [
        userRow?.user_id ?? null,
        String(username),
        userRow?.company_id ?? null,
        userRow?.ship_id ?? null,
        String(finalActivityType),
        trainingType ?? null,
        JSON.stringify({ username, trainingType, timestamp, activityType, ...rest }),
        occurredAt,
      ]
    );

    return res.status(201).json({
      message: "Activity logged",
      log: insert.rows[0],
    });
  } catch (err) {
    console.error("Error trackActivity:", err);
    return res.status(500).json({ error: "Failed to log activity" });
  }
};

/**
 * GET /activity
 * Role-based:
 * - role 1: all logs (optional filter by company_id, ship_id, username)
 * - role 2: only own company logs
 * - role 3/4: only own ship logs
 */
export const getActivityLogs = async (req, res) => {
  try {
    const { role_id, company_id, ship_id, user_id } = req.user;

    const {
      company_id: qCompanyId,
      ship_id: qShipId,
      username: qUsername,
      user_id: qUserId,
      limit = 100,
    } = req.query;

    const lim = Math.min(Number(limit) || 100, 500);

    // ROLE 1: superadmin (can filter anything)
    if (Number(role_id) === 1) {
      const filters = [];
      const values = [];
      let i = 1;

      if (qCompanyId) { filters.push(`company_id = $${i++}`); values.push(String(qCompanyId)); }
      if (qShipId) { filters.push(`ship_id = $${i++}`); values.push(Number(qShipId)); }
      if (qUsername) { filters.push(`username = $${i++}`); values.push(String(qUsername)); }
      if (qUserId) { filters.push(`user_id = $${i++}`); values.push(Number(qUserId)); }

      const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
      const sql = `
        SELECT *
        FROM activity_logs
        ${where}
        ORDER BY occurred_at DESC
        LIMIT ${lim}
      `;

      const { rows } = await db.query(sql, values);
      return res.json(rows);
    }

    // ROLE 2: admin (company scoped)
    if (Number(role_id) === 2) {
      const filters = [`company_id = $1`];
      const values = [company_id];
      let i = 2;

      if (qShipId) { filters.push(`ship_id = $${i++}`); values.push(Number(qShipId)); }
      if (qUsername) { filters.push(`username = $${i++}`); values.push(String(qUsername)); }
      if (qUserId) { filters.push(`user_id = $${i++}`); values.push(Number(qUserId)); }

      const sql = `
        SELECT *
        FROM activity_logs
        WHERE ${filters.join(" AND ")}
        ORDER BY occurred_at DESC
        LIMIT $${i}
      `;
      values.push(lim);

      const { rows } = await db.query(sql, values);
      return res.json(rows);
    }

    // ROLE 3: subadmin (ship scoped)
    if (Number(role_id) === 3) {
      if (!ship_id) return res.json([]);

      const filters = [`ship_id = $1`];
      const values = [ship_id];
      let i = 2;

      if (qUsername) { filters.push(`username = $${i++}`); values.push(String(qUsername)); }
      if (qUserId) { filters.push(`user_id = $${i++}`); values.push(Number(qUserId)); }

      const sql = `
        SELECT *
        FROM activity_logs
        WHERE ${filters.join(" AND ")}
        ORDER BY occurred_at DESC
        LIMIT $${i}
      `;
      values.push(lim);

      const { rows } = await db.query(sql, values);
      return res.json(rows);
    }

    // ROLE 4: crew (ONLY own logs)
    if (Number(role_id) === 4) {
      const sql = `
        SELECT *
        FROM activity_logs
        WHERE user_id = $1
        ORDER BY occurred_at DESC
        LIMIT $2
      `;
      const { rows } = await db.query(sql, [user_id, lim]);
      return res.json(rows);
    }

    return res.json([]);
  } catch (err) {
    console.error("Error getActivityLogs:", err);
    return res.status(500).json({ error: "Failed to fetch activity logs" });
  }
};

// ==============================================================================
// this changes to be added in dev manually later after vercel deploy undo - DONE
// ==============================================================================