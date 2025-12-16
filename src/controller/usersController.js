// src/controller/usersController.js
import { db } from '../db.js';
import crypto from 'crypto';

const normalizeStatus = (s) => (s ? String(s).trim().toLowerCase() : null);
const isOnboard = (s) => normalizeStatus(s) === 'onboard';

// password generator (readable)
const generatePassword = (length = 12) => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789@#$';
  let out = '';
  const bytes = crypto.randomBytes(length);
  for (let i = 0; i < length; i++) out += chars[bytes[i] % chars.length];
  return out;
};

// hash password (upgrade to bcrypt later)
const hashPassword = (plain) =>
  crypto.createHash('sha256').update(String(plain)).digest('hex');

// generate username based on seafarer_id + random suffix to avoid collisions
const generateUsername = (seafarerId) => {
  const base = String(seafarerId).toLowerCase().replace(/[^a-z0-9]/g, '');
  const suffix = crypto.randomBytes(3).toString('hex'); // 6 chars
  return `${base}.${suffix}`;
};

const MAX_USERNAME_TRIES = 5;

const createUniqueUsername = async (seafarerId) => {
  for (let i = 0; i < MAX_USERNAME_TRIES; i++) {
    const candidate = generateUsername(seafarerId);
    const { rows } = await db.query(
      `SELECT 1 FROM users WHERE username = $1 LIMIT 1`,
      [candidate]
    );
    if (rows.length === 0) return candidate;
  }
  throw new Error('Failed to generate unique username');
};

// GET /users
export const getAllUsers = async (req, res) => {
  try {
    const { rows } = await db.query('SELECT * FROM users ORDER BY user_id');
    res.json(rows);
  } catch (err) {
    console.error('Error getting users:', err);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
};

// GET /users/:id
export const getUserById = async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) return res.status(400).json({ error: 'user_id must be a number' });

  try {
    const { rows } = await db.query('SELECT * FROM users WHERE user_id = $1', [id]);
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error('Error getting user:', err);
    res.status(500).json({ error: 'Failed to fetch user' });
  }
};

// POST /users
// Create the person record. Credentials are generated ONLY if status=Onboard.
export const createUser = async (req, res) => {
  const {
    seafarer_id,
    full_name,
    rank,
    trip,
    embarkation_date,
    disembarkation_date,
    status,
    ship_id,
    company_id, // note: in your DB this is UUID string
  } = req.body;

  if (!seafarer_id || !full_name) {
    return res.status(400).json({ error: 'seafarer_id and full_name are required' });
  }

  const onboardNow = isOnboard(status);

  try {
    let generatedUsername = null;
    let generatedPassword = null;
    let passwordHashToStore = null;

    if (onboardNow) {
      generatedUsername = await createUniqueUsername(seafarer_id);
      generatedPassword = generatePassword(12);
      passwordHashToStore = hashPassword(generatedPassword);
    }

    const { rows } = await db.query(
      `INSERT INTO users
       (seafarer_id, full_name, rank, trip,
        embarkation_date, disembarkation_date,
        status, username, password_hash,
        ship_id, company_id, created_at, updated_at)
       VALUES
       ($1, $2, $3, $4,
        $5, $6,
        $7, $8, $9,
        $10, $11, NOW(), NOW())
       RETURNING *`,
      [
        seafarer_id,
        full_name,
        rank || null,
        trip || null,
        embarkation_date || null,
        disembarkation_date || null,
        status || null,
        generatedUsername,      // null if not onboard
        passwordHashToStore,    // null if not onboard
        ship_id || null,
        company_id || null,
      ]
    );

    res.status(201).json({
      user: rows[0],
      credentials: onboardNow
        ? { username: generatedUsername, password: generatedPassword }
        : null,
    });
  } catch (err) {
    console.error('Error creating user:', err);

    // seafarer_id unique forever (and maybe username unique too)
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Duplicate seafarer_id (must be unique forever)' });
    }

    res.status(500).json({ error: 'Failed to create user' });
  }
};

// PUT /users/:id
// Option A:
// - Every time status becomes Onboard => generate NEW username + NEW password
// - Every time status becomes NOT onboard => clear username + password_hash
export const updateUser = async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) return res.status(400).json({ error: 'user_id must be a number' });

  const {
    seafarer_id,
    full_name,
    rank,
    trip,
    embarkation_date,
    disembarkation_date,
    status,
    ship_id,
    company_id,
  } = req.body;

  try {
    // Fetch current user including creds
    const currentRes = await db.query(
      `SELECT user_id, seafarer_id, status, username, password_hash
       FROM users
       WHERE user_id = $1`,
      [id]
    );
    if (!currentRes.rows.length) return res.status(404).json({ error: 'User not found' });

    const current = currentRes.rows[0];

    const nextStatus = status !== undefined ? status : current.status;
    const nextOnboard = isOnboard(nextStatus);

    const hasCreds = !!(current.username && current.password_hash);

    let newUsername = null;
    let newPassword = null;
    let newPasswordHash = null;

    // Generate creds ONLY ONCE: when user becomes onboard and has no creds yet
    if (nextOnboard && !hasCreds) {
      const sidForUsername = seafarer_id || current.seafarer_id;
      newUsername = await createUniqueUsername(sidForUsername);
      newPassword = generatePassword(12);
      newPasswordHash = hashPassword(newPassword);
    }

    const { rowCount } = await db.query(
      `UPDATE users
       SET
         seafarer_id         = COALESCE($1, seafarer_id),
         full_name           = COALESCE($2, full_name),
         rank                = COALESCE($3, rank),
         trip                = COALESCE($4, trip),
         embarkation_date    = COALESCE($5, embarkation_date),
         disembarkation_date = COALESCE($6, disembarkation_date),
         status              = COALESCE($7, status),

         -- IMPORTANT: do NOT wipe creds on offboard
         username            = COALESCE($8::varchar, username),
         password_hash       = COALESCE($9::varchar, password_hash),

         ship_id             = COALESCE($10, ship_id),
         company_id          = COALESCE($11::uuid, company_id),
         updated_at          = NOW()
       WHERE user_id = $12`,
      [
        seafarer_id,
        full_name,
        rank,
        trip,
        embarkation_date,
        disembarkation_date,
        status,
        newUsername,      // only set if generated
        newPasswordHash,  // only set if generated
        ship_id,
        company_id,
        id,
      ]
    );

    if (!rowCount) return res.status(404).json({ error: 'User not found' });

    res.json({
      message: 'User updated',
      credentials: newUsername && newPassword ? { username: newUsername, password: newPassword } : null,
    });
  } catch (err) {
    console.error('Error updating user:', err);

    if (err.code === '23505') {
      return res.status(409).json({ error: 'Duplicate seafarer_id (must be unique forever)' });
    }

    res.status(500).json({ error: 'Failed to update user' });
  }
};


// DELETE /users/:id
export const deleteUser = async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) return res.status(400).json({ error: 'user_id must be a number' });

  try {
    const { rowCount } = await db.query('DELETE FROM users WHERE user_id = $1', [id]);
    if (!rowCount) return res.status(404).json({ error: 'User not found' });
    res.json({ message: 'User deleted' });
  } catch (err) {
    console.error('Error deleting user:', err);
    res.status(500).json({ error: 'Failed to delete user' });
  }
};
