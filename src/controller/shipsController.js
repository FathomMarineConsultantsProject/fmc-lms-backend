// src/controller/shipsController.js
import { db } from '../db.js';

// GET /ships
export const getAllShips = async (req, res) => {
  try {
    const { rows } = await db.query('SELECT * FROM ships ORDER BY ship_id');
    res.json(rows);
  } catch (err) {
    console.error('Error getting ships:', err);
    res.status(500).json({ error: 'Failed to fetch ships' });
  }
};

// GET /ships/:id
export const getShipById = async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT * FROM ships WHERE ship_id = $1',
      [req.params.id]
    );

    if (!rows.length) {
      return res.status(404).json({ error: 'Ship not found' });
    }

    res.json(rows[0]);
  } catch (err) {
    console.error('Error getting ship:', err);
    res.status(500).json({ error: 'Failed to fetch ship' });
  }
};

// POST /ships
// body example:
// {
//   "company_id": 1,
//   "ship_name": "My Ship",
//   "imo_number": "1234567",
//   "flag": "IN",
//   "class": "A1",
//   "owner": "Owner Name",
//   "validity": "2026-12-31",
//   "ship_type": "Bulk Carrier",
//   "capacity": 10000,
//   "powered_by": "Diesel"
// }
export const createShip = async (req, res) => {
  const {
    ship_name,
    imo_number,
    flag,
    class: ship_class,
    owner,
    validity,
    ship_type,
    capacity,
    powered_by,
    company_id,
  } = req.body;

  if (!company_id || !ship_name) {
    return res
      .status(400)
      .json({ error: 'company_id and ship_name are required' });
  }

  try {
    const { rows } = await db.query(
      `INSERT INTO ships
       (ship_name, imo_number, flag, class, owner, validity,
        ship_type, capacity, powered_by, company_id,
        created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6,
               $7, $8, $9, $10,
               NOW(), NOW())
       RETURNING *`,
      [
        ship_name,
        imo_number || null,
        flag || null,
        ship_class || null,
        owner || null,
        validity || null,      // string/date acceptable
        ship_type || null,
        capacity || null,
        powered_by || null,
        company_id,
      ]
    );

    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('Error creating ship:', err);
    res.status(500).json({ error: 'Failed to create ship' });
  }
};

// PUT /ships/:id
export const updateShip = async (req, res) => {
  const {
    ship_name,
    imo_number,
    flag,
    class: ship_class,
    owner,
    validity,
    ship_type,
    capacity,
    powered_by,
    company_id,
  } = req.body;

  try {
    const { rowCount } = await db.query(
      `UPDATE ships
       SET
         ship_name  = COALESCE($1, ship_name),
         imo_number = COALESCE($2, imo_number),
         flag       = COALESCE($3, flag),
         class      = COALESCE($4, class),
         owner      = COALESCE($5, owner),
         validity   = COALESCE($6, validity),
         ship_type  = COALESCE($7, ship_type),
         capacity   = COALESCE($8, capacity),
         powered_by = COALESCE($9, powered_by),
         company_id = COALESCE($10, company_id),
         updated_at = NOW()
       WHERE ship_id = $11`,
      [
        ship_name,
        imo_number,
        flag,
        ship_class,
        owner,
        validity,
        ship_type,
        capacity,
        powered_by,
        company_id,
        req.params.id,
      ]
    );

    if (!rowCount) {
      return res.status(404).json({ error: 'Ship not found' });
    }

    res.json({ message: 'Ship updated' });
  } catch (err) {
    console.error('Error updating ship:', err);
    res.status(500).json({ error: 'Failed to update ship' });
  }
};

// DELETE /ships/:id
export const deleteShip = async (req, res) => {
  try {
    const { rowCount } = await db.query(
      'DELETE FROM ships WHERE ship_id = $1',
      [req.params.id]
    );

    if (!rowCount) {
      return res.status(404).json({ error: 'Ship not found' });
    }

    res.json({ message: 'Ship deleted' });
  } catch (err) {
    console.error('Error deleting ship:', err);
    res.status(500).json({ error: 'Failed to delete ship' });
  }
};
