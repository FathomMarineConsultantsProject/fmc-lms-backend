// src/controller/authController.js
import { db } from '../db.js';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';

// -------------------- constants --------------------
const ROLE_SUPERADMIN = 1;
const ROLE_ADMIN = 2;
const ROLE_SUBADMIN = 3;
const ROLE_CREW = 4;

const ACCESS_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '5h';
const REFRESH_EXPIRES_DAYS = Number(process.env.REFRESH_EXPIRES_DAYS || 7);

// -------------------- helpers --------------------
const normalizeStatus = (s) => (s ? String(s).trim().toLowerCase() : null);
const isOnboard = (s) => normalizeStatus(s) === 'onboard';

// ✅ Admin roles are "Onboard" by default (status doesn't matter for login)
const isAdminRole = (roleId) =>
  [ROLE_SUPERADMIN, ROLE_ADMIN, ROLE_SUBADMIN].includes(Number(roleId));

// sha256 hash (your current approach)
const hashPassword = (plain) =>
  crypto.createHash('sha256').update(String(plain)).digest('hex');

// AES-256-GCM reversible encryption (Option B)
const getEncKey = () => {
  const b64 = process.env.PASSWORD_ENC_KEY;
  if (!b64) throw new Error('PASSWORD_ENC_KEY missing in .env');
  const key = Buffer.from(b64, 'base64');
  if (key.length !== 32) throw new Error('PASSWORD_ENC_KEY must be 32 bytes base64');
  return key;
};

/**
 * Returns: base64(iv).base64(tag).base64(ciphertext)
 */
const encryptPassword = (plain) => {
  const key = getEncKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

  const ciphertext = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return `${iv.toString('base64')}.${tag.toString('base64')}.${ciphertext.toString('base64')}`;
};

const decryptPassword = (enc) => {
  if (!enc) return null;
  const key = getEncKey();
  const parts = String(enc).split('.');
  if (parts.length !== 3) throw new Error('Invalid password_enc format');

  const iv = Buffer.from(parts[0], 'base64');
  const tag = Buffer.from(parts[1], 'base64');
  const ciphertext = Buffer.from(parts[2], 'base64');

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);

  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plain.toString('utf8');
};

// reset token flow (forgot/reset password)
const generateResetToken = () => crypto.randomBytes(24).toString('hex');
const hashResetToken = (token) =>
  crypto.createHash('sha256').update(String(token)).digest('hex');

// refresh token flow
const generateRefreshToken = () => crypto.randomBytes(48).toString('hex');
const hashRefreshToken = (token) =>
  crypto.createHash('sha256').update(String(token)).digest('hex');

const signAccessToken = (user) => {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET missing in .env');

  return jwt.sign(
    {
      user_id: user.user_id,
      role_id: user.role_id,
      company_id: user.company_id,
      ship_id: user.ship_id,
    },
    secret,
    { expiresIn: ACCESS_EXPIRES_IN }
  );
};

const canAdmin = (roleId) => [ROLE_SUPERADMIN, ROLE_ADMIN, ROLE_SUBADMIN].includes(Number(roleId));

// company/ship scope checks for admin actions on other users
const ensureUserScopeForAdmin = async (req, targetUserId) => {
  const role = Number(req.user?.role_id);

  if (role === ROLE_SUPERADMIN) return true;

  if (role === ROLE_ADMIN) {
    const r = await db.query(`SELECT company_id FROM users WHERE user_id = $1`, [Number(targetUserId)]);
    if (!r.rows.length) return false;
    return String(r.rows[0].company_id) === String(req.user.company_id);
  }

  if (role === ROLE_SUBADMIN) {
    const r = await db.query(`SELECT company_id, ship_id FROM users WHERE user_id = $1`, [Number(targetUserId)]);
    if (!r.rows.length) return false;
    return (
      String(r.rows[0].company_id) === String(req.user.company_id) &&
      Number(r.rows[0].ship_id) === Number(req.user.ship_id)
    );
  }

  return false;
};

// -------------------- AUTH: LOGIN (access + refresh) --------------------
export const login = async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'username and password are required' });
  }

  try {
    const { rows } = await db.query(
      `
      SELECT user_id, full_name, status, username, password_hash, role_id, ship_id, company_id
      FROM users
      WHERE username = $1
      LIMIT 1
      `,
      [String(username)]
    );

    if (!rows.length) return res.status(401).json({ error: 'Invalid credentials' });

    const user = rows[0];

    // ✅ Only ROLE_CREW must be onboard to login
    if (!isAdminRole(user.role_id) && !isOnboard(user.status)) {
      return res.status(403).json({ error: 'User is not onboard. Login disabled.' });
    }

    const incomingHash = hashPassword(password);
    if (incomingHash !== user.password_hash) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Access token (5h or env)
    const access_token = signAccessToken(user);

    // Refresh token (stored server-side as hash)
    const refresh_token = generateRefreshToken();
    const refresh_hash = hashRefreshToken(refresh_token);

    await db.query(
      `
      INSERT INTO refresh_sessions (user_id, refresh_token_hash, expires_at)
      VALUES ($1, $2, NOW() + ($3 || ' days')::interval)
      `,
      [user.user_id, refresh_hash, String(REFRESH_EXPIRES_DAYS)]
    );

    return res.json({
      message: 'Login successful',
      access_token,
      refresh_token,
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
    return res.status(500).json({ error: 'Login failed' });
  }
};

// -------------------- AUTH: SIGNUP --------------------
export const signup = async (req, res) => {
  const {
    seafarer_id,
    full_name,
    username,
    password,
    company_id,
    ship_id,
    rank,
    trip,
    status = 'onboard',
    role_id = ROLE_CREW,
    embarkation_date,
    disembarkation_date,
  } = req.body;

  if (!seafarer_id || !full_name || !username || !password) {
    return res.status(400).json({ error: 'seafarer_id, full_name, username, password are required' });
  }

  try {
    const password_hash = hashPassword(password);
    const password_enc = encryptPassword(password);

    const finalRoleId = Number(role_id);
    // ✅ Admin roles default onboard
    const finalStatus =
      isAdminRole(finalRoleId) ? 'Onboard' : (status ?? null);

    const { rows } = await db.query(
      `
      INSERT INTO users
        (seafarer_id, full_name, rank, trip,
         embarkation_date, disembarkation_date,
         status, username, password_hash, password_enc,
         ship_id, company_id, role_id, created_at, updated_at)
      VALUES
        ($1,$2,$3,$4,
         $5,$6,
         $7,$8,$9,$10,
         $11,$12,$13, NOW(), NOW())
      RETURNING user_id, seafarer_id, full_name, username, role_id, company_id, ship_id, status
      `,
      [
        String(seafarer_id),
        String(full_name),
        rank ?? null,
        trip ?? null,
        embarkation_date ?? null,
        disembarkation_date ?? null,
        finalStatus,
        String(username),
        password_hash,
        password_enc,
        ship_id != null ? Number(ship_id) : null,
        company_id ?? null,
        finalRoleId,
      ]
    );

    return res.status(201).json({
      message: 'Signup successful',
      user: rows[0],
    });
  } catch (err) {
    console.error('Error signing up:', err);
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Duplicate username or seafarer_id' });
    }
    return res.status(500).json({ error: 'Signup failed' });
  }
};

// -------------------- AUTH: FORGOT PASSWORD --------------------
export const forgotPassword = async (req, res) => {
  const { username } = req.body;
  if (!username) return res.status(400).json({ error: 'username is required' });

  try {
    const u = await db.query(`SELECT user_id FROM users WHERE username = $1 LIMIT 1`, [String(username)]);

    // Don't reveal existence
    if (!u.rows.length) return res.json({ message: 'If account exists, reset token generated' });

    const token = generateResetToken();
    const tokenHash = hashResetToken(token);

    const { rowCount } = await db.query(
      `
      UPDATE users
      SET reset_token_hash = $1,
          reset_token_expires_at = NOW() + INTERVAL '15 minutes',
          updated_at = NOW()
      WHERE user_id = $2
      `,
      [tokenHash, u.rows[0].user_id]
    );

    if (!rowCount) return res.json({ message: 'If account exists, reset token generated' });

    // returning token because no email flow yet
    return res.json({
      message: 'Reset token generated',
      reset_token: token,
      expires_in_minutes: 15,
    });
  } catch (err) {
    console.error('Error forgotPassword:', err);
    return res.status(500).json({ error: 'Forgot password failed' });
  }
};

// -------------------- AUTH: RESET PASSWORD --------------------
export const resetPassword = async (req, res) => {
  const { username, reset_token, new_password } = req.body;
  if (!username || !reset_token || !new_password) {
    return res.status(400).json({ error: 'username, reset_token, new_password are required' });
  }

  try {
    const tokenHash = hashResetToken(reset_token);

    const u = await db.query(
      `
      SELECT user_id, reset_token_hash, reset_token_expires_at
      FROM users
      WHERE username = $1
      LIMIT 1
      `,
      [String(username)]
    );

    if (!u.rows.length) return res.status(400).json({ error: 'Invalid reset token' });

    const user = u.rows[0];

    if (!user.reset_token_hash || user.reset_token_hash !== tokenHash) {
      return res.status(400).json({ error: 'Invalid reset token' });
    }

    if (!user.reset_token_expires_at || new Date(user.reset_token_expires_at) < new Date()) {
      return res.status(400).json({ error: 'Reset token expired' });
    }

    const password_hash = hashPassword(new_password);
    const password_enc = encryptPassword(new_password);

    await db.query(
      `
      UPDATE users
      SET password_hash = $1,
          password_enc = $2,
          reset_token_hash = NULL,
          reset_token_expires_at = NULL,
          updated_at = NOW()
      WHERE user_id = $3
      `,
      [password_hash, password_enc, user.user_id]
    );

    // OPTIONAL: revoke ALL refresh sessions for this user (recommended)
    await db.query(`UPDATE refresh_sessions SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL`, [
      user.user_id,
    ]);

    return res.json({ message: 'Password reset successful' });
  } catch (err) {
    console.error('Error resetPassword:', err);
    return res.status(500).json({ error: 'Reset password failed' });
  }
};

// -------------------- AUTH: REFRESH ACCESS TOKEN --------------------
export const refreshAccessToken = async (req, res) => {
  const { refresh_token } = req.body;
  if (!refresh_token) return res.status(400).json({ error: 'refresh_token is required' });

  try {
    const refresh_hash = hashRefreshToken(refresh_token);

    const s = await db.query(
      `
      SELECT session_id, user_id, expires_at, revoked_at
      FROM refresh_sessions
      WHERE refresh_token_hash = $1
      LIMIT 1
      `,
      [refresh_hash]
    );

    if (!s.rows.length) return res.status(401).json({ error: 'Invalid refresh token' });

    const session = s.rows[0];
    if (session.revoked_at) return res.status(401).json({ error: 'Refresh token revoked' });
    if (new Date(session.expires_at) < new Date()) return res.status(401).json({ error: 'Refresh token expired' });

    const u = await db.query(
      `SELECT user_id, full_name, status, role_id, ship_id, company_id FROM users WHERE user_id = $1 LIMIT 1`,
      [session.user_id]
    );
    if (!u.rows.length) return res.status(401).json({ error: 'User not found' });

    const user = u.rows[0];

    // ✅ Only ROLE_CREW must be onboard
    if (!isAdminRole(user.role_id) && !isOnboard(user.status)) {
      return res.status(403).json({ error: 'User is not onboard. Login disabled.' });
    }

    const access_token = signAccessToken(user);
    return res.json({ access_token });
  } catch (err) {
    console.error('Error refreshAccessToken:', err);
    return res.status(500).json({ error: 'Refresh failed' });
  }
};

// -------------------- AUTH: LOGOUT (revoke refresh) --------------------
export const logout = async (req, res) => {
  const { refresh_token } = req.body;
  if (!refresh_token) return res.status(400).json({ error: 'refresh_token is required' });

  try {
    const refresh_hash = hashRefreshToken(refresh_token);

    await db.query(
      `
      UPDATE refresh_sessions
      SET revoked_at = NOW()
      WHERE refresh_token_hash = $1
      `,
      [refresh_hash]
    );

    return res.json({ message: 'Logged out' });
  } catch (err) {
    console.error('Error logout:', err);
    return res.status(500).json({ error: 'Logout failed' });
  }
};

// -------------------- ADMIN: VIEW USER PASSWORD (Option B) --------------------
export const adminViewPassword = async (req, res) => {
  if (!canAdmin(req.user?.role_id)) return res.status(403).json({ error: 'Forbidden' });

  const { user_id } = req.params;
  const targetUserId = Number(user_id);
  if (!targetUserId) return res.status(400).json({ error: 'user_id must be a number' });

  try {
    const inScope = await ensureUserScopeForAdmin(req, targetUserId);
    if (!inScope) return res.status(403).json({ error: 'Forbidden (scope)' });

    const r = await db.query(
      `
      SELECT user_id, full_name, username, password_enc
      FROM users
      WHERE user_id = $1
      LIMIT 1
      `,
      [targetUserId]
    );

    if (!r.rows.length) return res.status(404).json({ error: 'User not found' });

    const enc = r.rows[0].password_enc;
    const plain = enc ? decryptPassword(enc) : null;

    return res.json({
      user_id: r.rows[0].user_id,
      full_name: r.rows[0].full_name,
      username: r.rows[0].username,
      password: plain,
    });
  } catch (err) {
    console.error('Error adminViewPassword:', err);
    return res.status(500).json({ error: 'Failed to view password' });
  }
};

// -------------------- ADMIN: SET/CHANGE USER PASSWORD --------------------
export const adminSetPassword = async (req, res) => {
  if (!canAdmin(req.user?.role_id)) return res.status(403).json({ error: 'Forbidden' });

  const { user_id } = req.params;
  const targetUserId = Number(user_id);
  if (!targetUserId) return res.status(400).json({ error: 'user_id must be a number' });

  const { new_password } = req.body;
  if (!new_password) return res.status(400).json({ error: 'new_password is required' });

  try {
    const inScope = await ensureUserScopeForAdmin(req, targetUserId);
    if (!inScope) return res.status(403).json({ error: 'Forbidden (scope)' });

    const password_hash = hashPassword(new_password);
    const password_enc = encryptPassword(new_password);

    const { rowCount } = await db.query(
      `
      UPDATE users
      SET password_hash = $1,
          password_enc = $2,
          updated_at = NOW()
      WHERE user_id = $3
      `,
      [password_hash, password_enc, targetUserId]
    );

    if (!rowCount) return res.status(404).json({ error: 'User not found' });

    // OPTIONAL: revoke ALL refresh sessions for this user (recommended)
    await db.query(`UPDATE refresh_sessions SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL`, [
      targetUserId,
    ]);

    return res.json({ message: 'Password updated' });
  } catch (err) {
    console.error('Error adminSetPassword:', err);
    return res.status(500).json({ error: 'Failed to update password' });
  }
};
