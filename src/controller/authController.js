// src/controller/authController.js
import { db } from '../db.js';
import crypto from 'crypto';

const normalizeStatus = (s) => (s ? String(s).trim().toLowerCase() : null);
const isOnboard = (s) => normalizeStatus(s) === 'onboard';

const hashPassword = (plain) =>
  crypto.createHash('sha256').update(String(plain)).digest('hex');

// POST /auth/login
// Body: { "username": "xxx", "password": "yyy" }
export const login = async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'username and password are required' });
  }

  try {
    const { rows } = await db.query(
      `
      SELECT user_id, seafarer_id, full_name, rank, trip,
             status, ship_id, company_id, username, password_hash
      FROM users
      WHERE username = $1
      LIMIT 1
      `,
      [String(username)]
    );

    // Don’t reveal if username exists or not
    if (!rows.length) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const user = rows[0];

    // Must be onboard to login
    if (!isOnboard(user.status)) {
      return res.status(403).json({ error: 'User is not onboard. Login disabled.' });
    }

    // Must have creds set
    if (!user.password_hash) {
      return res.status(403).json({ error: 'User has no active credentials. Contact admin.' });
    }

    const incomingHash = hashPassword(password);
    if (incomingHash !== user.password_hash) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // For now, no JWT/session (we’ll add later if needed)
    // Return user profile (exclude password_hash)
    return res.json({
      message: 'Login successful',
      user: {
        user_id: user.user_id,
        seafarer_id: user.seafarer_id,
        full_name: user.full_name,
        rank: user.rank,
        trip: user.trip,
        status: user.status,
        ship_id: user.ship_id,
        company_id: user.company_id,
        username: user.username,
      },
    });
  } catch (err) {
    console.error('Error logging in:', err);
    return res.status(500).json({ error: 'Login failed' });
  }
};

// POST /auth/change-password
// Body: { "username": "...", "old_password": "...", "new_password": "..." }
// Rule: only onboard can change password
export const changePassword = async (req, res) => {
  const { username, old_password, new_password } = req.body;

  if (!username || !old_password || !new_password) {
    return res.status(400).json({
      error: 'username, old_password, and new_password are required',
    });
  }

  if (String(new_password).length < 8) {
    return res.status(400).json({ error: 'new_password must be at least 8 characters' });
  }

  try {
    const { rows } = await db.query(
      `
      SELECT user_id, status, password_hash
      FROM users
      WHERE username = $1
      LIMIT 1
      `,
      [String(username)]
    );

    if (!rows.length) return res.status(401).json({ error: 'Invalid credentials' });

    const user = rows[0];

    if (!isOnboard(user.status)) {
      return res.status(403).json({ error: 'User is not onboard. Password change disabled.' });
    }

    const oldHash = hashPassword(old_password);
    if (oldHash !== user.password_hash) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const newHash = hashPassword(new_password);

    await db.query(
      `
      UPDATE users
      SET password_hash = $1,
          updated_at = NOW()
      WHERE user_id = $2
      `,
      [newHash, user.user_id]
    );

    return res.json({ message: 'Password updated successfully' });
  } catch (err) {
    console.error('Error changing password:', err);
    return res.status(500).json({ error: 'Failed to change password' });
  }
};
