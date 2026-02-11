// src/controller/deviceController.js
import { db } from "../db.js";

// simple API key protection for Unity calls (similar to activity)
// Add DEVICE_API_KEY=some_secret in .env
const requireDeviceKey = (req, res) => {
  const key =
    req.headers["x-device-key"] ||
    req.headers["device_api_key"] ||
    req.headers["device-api-key"];

  const expected = process.env.DEVICE_API_KEY;
  if (!expected) return true;

  if (String(key || "") !== String(expected)) {
    res.status(401).json({ isSuccess: false, errorMessage: "Invalid device key" });
    return false;
  }
  return true;
};

const norm = (s) => String(s || "").trim().toLowerCase();

/**
 * POST /device/set
 * Body: { "username": "crew.one", "deviceId": "abc-123" }
 * - Finds user by username (case-insensitive, trimmed)
 * - Stores device_id
 */
export const setDeviceId = async (req, res) => {
  if (!requireDeviceKey(req, res)) return;

  const { username, deviceId } = req.body || {};
  if (!username || !deviceId) {
    return res.status(400).json({
      isSuccess: false,
      errorMessage: "username and deviceId are required",
    });
  }

  try {
    const r = await db.query(
      `
      UPDATE users
      SET device_id = $1,
          updated_at = NOW()
      WHERE LOWER(TRIM(username)) = LOWER(TRIM($2))
      RETURNING user_id, username, device_id
      `,
      [String(deviceId).trim(), String(username)]
    );

    if (!r.rows.length) {
      return res.status(404).json({
        isSuccess: false,
        errorMessage: "User not found for given username",
      });
    }

    return res.json({
      isSuccess: true,
      errorMessage: null,
      user_id: r.rows[0].user_id,
      username: r.rows[0].username,
      deviceId: r.rows[0].device_id,
    });
  } catch (err) {
    console.error("setDeviceId error:", err);
    return res.status(500).json({ isSuccess: false, errorMessage: "Failed to set device id" });
  }
};

/**
 * POST /device/get
 * Body: { "username": "crew.one" }
 * Returns { deviceId, errorMessage } as your Unity class expects
 */
export const getDeviceId = async (req, res) => {
  if (!requireDeviceKey(req, res)) return;

  const { username } = req.body || {};
  if (!username) {
    return res.status(400).json({ deviceId: null, errorMessage: "username is required" });
  }

  try {
    const r = await db.query(
      `
      SELECT user_id, username, device_id
      FROM users
      WHERE LOWER(TRIM(username)) = LOWER(TRIM($1))
      LIMIT 1
      `,
      [String(username)]
    );

    if (!r.rows.length) {
      return res.status(404).json({ deviceId: null, errorMessage: "User not found" });
    }

    return res.json({
      user_id: r.rows[0].user_id,
      username: r.rows[0].username,
      deviceId: r.rows[0].device_id ?? null,
      errorMessage: null,
    });
  } catch (err) {
    console.error("getDeviceId error:", err);
    return res.status(500).json({ deviceId: null, errorMessage: "Failed to get device id" });
  }
};
