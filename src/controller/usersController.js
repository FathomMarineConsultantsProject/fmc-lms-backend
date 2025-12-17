// src/controller/usersController.js
import { db } from '../db.js';

// GET /users
export const getAllUsers = async (req, res) => {
  try {
    const { role_id, company_id, ship_id, user_id } = req.user;

    // role 1
    if (role_id === 1) {
      const { rows } = await db.query('SELECT * FROM users ORDER BY user_id');
      return res.json(rows);
    }

    // role 2 (company)
    if (role_id === 2) {
      const { rows } = await db.query(
        'SELECT * FROM users WHERE company_id = $1 ORDER BY user_id',
        [company_id]
      );
      return res.json(rows);
    }

    // role 3 (ship)
    if (role_id === 3) {
      const { rows } = await db.query(
        'SELECT * FROM users WHERE company_id = $1 AND ship_id = $2 ORDER BY user_id',
        [company_id, ship_id]
      );
      return res.json(rows);
    }

    // role 4 (self only)
    const { rows } = await db.query(
      'SELECT * FROM users WHERE user_id = $1',
      [user_id]
    );
    return res.json(rows);
  } catch (err) {
    console.error('Error getting users:', err);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
};


// GET /users/:id
export const getUserById = async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) {
    return res.status(400).json({ error: 'user_id must be a number' });
  }

  try {
    const { rows } = await db.query(
      'SELECT * FROM users WHERE user_id = $1',
      [id]
    );

    if (!rows.length) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json(rows[0]);
  } catch (err) {
    console.error('Error getting user:', err);
    res.status(500).json({ error: 'Failed to fetch user' });
  }
};

// POST /users
// Example body:
// {
//   "seafarer_id": "SF-001",
//   "full_name": "John Doe",
//   "rank": "Captain",
//   "trip": 1,
//   "embarkation_date": "2025-01-01",
//   "disembarkation_date": "2025-06-01",
//   "status": "Onboard",
//   "username": "xyz_user",
//   "password_hash": "hashed_pw_here",
//   "ship_id": 1,
//   "company_id": 1
// }
export const createUser = async (req, res) => {
  const {
    seafarer_id,
    full_name,
    rank,
    trip,
    embarkation_date,
    disembarkation_date,
    status,
    username,
    password_hash,
    ship_id,
    company_id,
  } = req.body;

  if (!seafarer_id || !full_name) {
    return res
      .status(400)
      .json({ error: 'seafarer_id and full_name are required' });
  }

  try {
    const { rows } = await db.query(
      `INSERT INTO users
       (seafarer_id, full_name, rank, trip,
        embarkation_date, disembarkation_date,
        status, username, password_hash,
        ship_id, company_id,
        created_at, updated_at)
       VALUES
       ($1, $2, $3, $4,
        $5, $6,
        $7, $8, $9,
        $10, $11,
        NOW(), NOW())
       RETURNING *`,
      [
        seafarer_id,
        full_name,
        rank || null,
        trip || null,
        embarkation_date || null,
        disembarkation_date || null,
        status || null,
        username || null,
        password_hash || null,
        ship_id || null,
        company_id || null,
      ]
    );

    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('Error creating user:', err);
    res.status(500).json({ error: 'Failed to create user' });
  }
};

// PUT /users/:id
export const updateUser = async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) {
    return res.status(400).json({ error: 'user_id must be a number' });
  }

  const {
    seafarer_id,
    full_name,
    rank,
    trip,
    embarkation_date,
    disembarkation_date,
    status,
    username,
    password_hash,
    ship_id,
    company_id,
  } = req.body;

  try {
    const { rowCount } = await db.query(
      `UPDATE users
       SET
         seafarer_id        = COALESCE($1, seafarer_id),
         full_name          = COALESCE($2, full_name),
         rank               = COALESCE($3, rank),
         trip               = COALESCE($4, trip),
         embarkation_date   = COALESCE($5, embarkation_date),
         disembarkation_date= COALESCE($6, disembarkation_date),
         status             = COALESCE($7, status),
         username           = COALESCE($8, username),
         password_hash      = COALESCE($9, password_hash),
         ship_id            = COALESCE($10, ship_id),
         company_id         = COALESCE($11, company_id),
         updated_at         = NOW()
       WHERE user_id = $12`,
      [
        seafarer_id,
        full_name,
        rank,
        trip,
        embarkation_date,
        disembarkation_date,
        status,
        username,
        password_hash,
        ship_id,
        company_id,
        id,
      ]
    );

    if (!rowCount) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({ message: 'User updated' });
  } catch (err) {
    console.error('Error updating user:', err);
    res.status(500).json({ error: 'Failed to update user' });
  }
};

// DELETE /users/:id
export const deleteUser = async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) {
    return res.status(400).json({ error: 'user_id must be a number' });
  }

  try {
    const { rowCount } = await db.query(
      'DELETE FROM users WHERE user_id = $1',
      [id]
    );

    if (!rowCount) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({ message: 'User deleted' });
  } catch (err) {
    console.error('Error deleting user:', err);
    res.status(500).json({ error: 'Failed to delete user' });
  }
};
