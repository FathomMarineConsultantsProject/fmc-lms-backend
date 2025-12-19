import { db } from '../db.js';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';

const normalizeStatus = (s) => (s ? String(s).trim().toLowerCase() : null);
const isOnboard = (s) => normalizeStatus(s) === 'onboard';

const hashPassword = (plain) =>
  crypto.createHash('sha256').update(String(plain)).digest('hex');

export const login = async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'username and password are required' });
  }

  try {
    const { rows } = await db.query(
      `
      SELECT user_id, seafarer_id, full_name, status, username, password_hash, role_id, ship_id, company_id
      FROM users
      WHERE username = $1
      LIMIT 1
      `,
      [String(username)]
    );

    if (!rows.length) return res.status(401).json({ error: 'Invalid credentials' });

    const user = rows[0];

    if (!isOnboard(user.status)) {
      return res.status(403).json({ error: 'User is not onboard. Login disabled.' });
    }

    const incomingHash = hashPassword(password);
    if (incomingHash !== user.password_hash) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const secret = process.env.JWT_SECRET;
    const expiresIn = process.env.JWT_EXPIRES_IN || '12h';

    const token = jwt.sign(
      {
        user_id: user.user_id,
        role_id: user.role_id,
        company_id: user.company_id,
        ship_id: user.ship_id,
      },
      secret,
      { expiresIn }
    );

    res.json({
      message: 'Login successful',
      token,
      user: {
        user_id: user.user_id,
        full_name: user.full_name,
        role_id: user.role_id,
        company_id: user.company_id,
        ship_id: user.ship_id,
      },
    });
  } catch (err) {
    console.error('Error logging in:', err);
    res.status(500).json({ error: 'Login failed' });
  }
};
