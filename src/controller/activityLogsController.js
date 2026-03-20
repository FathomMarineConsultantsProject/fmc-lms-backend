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
  if (!username) return res.status(400).json({ error: 'username is required' });

  const occurredAt = parseUnityTimestamp(timestamp) || new Date();
  const finalActivityType = activityType || 'training';

  try {
    // try resolve user_id/company_id/ship_id from username
    const u = await db.query(
      `SELECT user_id, company_id, ship_id FROM users WHERE username = $1 LIMIT 1`,
      [String(username)]
    );

    const userRow = u.rows[0] || null;

    const insert = await db.query(
      `
      INSERT INTO activity_logs
        (user_id, username, company_id, ship_id, activity_type, training_type, payload_json, occurred_at)
      VALUES
        ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
      RETURNING activity_id, username, activity_type, training_type, occurred_at
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
      message: 'Activity logged',
      log: insert.rows[0],
    });
  } catch (err) {
    console.error('Error trackActivity:', err);
    return res.status(500).json({ error: 'Failed to log activity' });
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
    const { role_id, company_id, ship_id } = req.user;
    const { company_id: qCompanyId, ship_id: qShipId, username: qUsername, limit = 100 } = req.query;

    const lim = Math.min(Number(limit) || 100, 500);

    // role 1: all logs, optional filters
    if (Number(role_id) === 1) {
      const filters = [];
      const values = [];
      let i = 1;

      if (qCompanyId) { filters.push(`company_id = $${i++}`); values.push(String(qCompanyId)); }
      if (qShipId) { filters.push(`ship_id = $${i++}`); values.push(Number(qShipId)); }
      if (qUsername) { filters.push(`username = $${i++}`); values.push(String(qUsername)); }

      const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
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

    // role 2: company scoped
    if (Number(role_id) === 2) {
      const { rows } = await db.query(
        `
        SELECT *
        FROM activity_logs
        WHERE company_id = $1
        ORDER BY occurred_at DESC
        LIMIT $2
        `,
        [company_id, lim]
      );
      return res.json(rows);
    }

    // role 3/4: ship scoped
    if (!ship_id) return res.json([]);
    const { rows } = await db.query(
      `
      SELECT *
      FROM activity_logs
      WHERE ship_id = $1
      ORDER BY occurred_at DESC
      LIMIT $2
      `,
      [ship_id, lim]
    );
    return res.json(rows);

  } catch (err) {
    console.error('Error getActivityLogs:', err);
    return res.status(500).json({ error: 'Failed to fetch activity logs' });
  }
};
