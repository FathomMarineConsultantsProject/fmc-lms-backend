// src/controller/shipsController.js
import { db } from '../db.js';

const ROLE_SUPERADMIN = 1;
const ROLE_ADMIN = 2;
const ROLE_SUBADMIN = 3;
const ROLE_CREW = 4;

const canWriteShips = (roleId) => roleId === ROLE_SUPERADMIN || roleId === ROLE_ADMIN;

export const getAllShips = async (req, res) => {
  try {
    const { role_id, company_id, ship_id } = req.user;
    const { company_id: queryCompanyId } = req.query;

    // ✅ Role 1 (SuperAdmin)
    if (role_id === ROLE_SUPERADMIN) {
      // Optional filter by company_id
      if (queryCompanyId) {
        const { rows } = await db.query(
          'SELECT * FROM ships WHERE company_id = $1 ORDER BY ship_id',
          [queryCompanyId]
        );
        return res.json(rows);
      }

      const { rows } = await db.query('SELECT * FROM ships ORDER BY ship_id');
      return res.json(rows);
    }

    // ✅ Role 2 (Admin) → only their company
    if (role_id === ROLE_ADMIN) {
      const { rows } = await db.query(
        'SELECT * FROM ships WHERE company_id = $1 ORDER BY ship_id',
        [company_id]
      );
      return res.json(rows);
    }

    // ✅ Role 3 / 4 → only their ship
    if (!ship_id) return res.json([]);
    const { rows } = await db.query(
      'SELECT * FROM ships WHERE ship_id = $1',
      [ship_id]
    );
    return res.json(rows);

  } catch (err) {
    console.error('Error getting ships:', err);
    res.status(500).json({ error: 'Failed to fetch ships' });
  }
};

// ROLE BASES ACCESS
// Rules applied

// Role 1: all ships

// Role 2: only ships in their company

// Role 3/4: only their ship

// Create/Update/Delete: Role 1 + Role 2 only (Role 2 restricted to their company)

//GET SHIP
export const getShipById = async (req, res) => {
  try {
    const shipId = parseInt(req.params.id, 10);
    if (Number.isNaN(shipId)) return res.status(400).json({ error: 'ship_id must be a number' });

    const { role_id, company_id, ship_id } = req.user;

    // fetch ship first
    const shipRes = await db.query('SELECT * FROM ships WHERE ship_id = $1', [shipId]);
    if (!shipRes.rows.length) return res.status(404).json({ error: 'Ship not found' });

    const ship = shipRes.rows[0];

    // authorize
    if (role_id === ROLE_SUPERADMIN) return res.json(ship);
    if (role_id === ROLE_ADMIN && String(ship.company_id) === String(company_id)) return res.json(ship);
    if ((role_id === ROLE_SUBADMIN || role_id === ROLE_CREW) && shipId === ship_id) return res.json(ship);

    return res.status(403).json({ error: 'Forbidden' });
  } catch (err) {
    console.error('Error getting ship:', err);
    res.status(500).json({ error: 'Failed to fetch ship' });
  }
};

//POST SHIP
export const createShip = async (req, res) => {
  const { role_id, company_id } = req.user;
  if (!canWriteShips(role_id)) return res.status(403).json({ error: 'Forbidden' });

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
    company_id: bodyCompanyId,
  } = req.body;

  if (!bodyCompanyId || !ship_name) {
    return res.status(400).json({ error: 'company_id and ship_name are required' });
  }

  // role2 can only create inside their company
  if (role_id === ROLE_ADMIN && String(bodyCompanyId) !== String(company_id)) {
    return res.status(403).json({ error: 'Forbidden (company scope)' });
  }

  try {
    const { rows } = await db.query(
      `INSERT INTO ships
       (ship_name, imo_number, flag, class, owner, validity,
        ship_type, capacity, powered_by, company_id,
        created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, NOW(), NOW())
       RETURNING *`,
      [
        ship_name,
        imo_number || null,
        flag || null,
        ship_class || null,
        owner || null,
        validity || null,
        ship_type || null,
        capacity || null,
        powered_by || null,
        bodyCompanyId,
      ]
    );

    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('Error creating ship:', err);
    res.status(500).json({ error: 'Failed to create ship' });
  }
};


//PUT SHIP
export const updateShip = async (req, res) => {
  const { role_id, company_id } = req.user;
  if (!canWriteShips(role_id)) return res.status(403).json({ error: 'Forbidden' });

  const shipId = parseInt(req.params.id, 10);
  if (Number.isNaN(shipId)) return res.status(400).json({ error: 'ship_id must be a number' });

  try {
    // scope check
    const current = await db.query('SELECT company_id FROM ships WHERE ship_id = $1', [shipId]);
    if (!current.rows.length) return res.status(404).json({ error: 'Ship not found' });

    if (role_id === ROLE_ADMIN && String(current.rows[0].company_id) !== String(company_id)) {
      return res.status(403).json({ error: 'Forbidden (company scope)' });
    }

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
      company_id: newCompanyId,
    } = req.body;

    // role2 cannot move ship to another company
    if (role_id === ROLE_ADMIN && newCompanyId && String(newCompanyId) !== String(company_id)) {
      return res.status(403).json({ error: 'Forbidden (cannot change company_id)' });
    }

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
        newCompanyId,
        shipId,
      ]
    );

    if (!rowCount) return res.status(404).json({ error: 'Ship not found' });
    res.json({ message: 'Ship updated' });
  } catch (err) {
    console.error('Error updating ship:', err);
    res.status(500).json({ error: 'Failed to update ship' });
  }
};

//DELETE SHIP
export const deleteShip = async (req, res) => {
  const { role_id, company_id } = req.user;
  if (!canWriteShips(role_id)) return res.status(403).json({ error: 'Forbidden' });

  const shipId = parseInt(req.params.id, 10);
  if (Number.isNaN(shipId)) return res.status(400).json({ error: 'ship_id must be a number' });

  try {
    const current = await db.query('SELECT company_id FROM ships WHERE ship_id = $1', [shipId]);
    if (!current.rows.length) return res.status(404).json({ error: 'Ship not found' });

    if (role_id === ROLE_ADMIN && String(current.rows[0].company_id) !== String(company_id)) {
      return res.status(403).json({ error: 'Forbidden (company scope)' });
    }

    const { rowCount } = await db.query('DELETE FROM ships WHERE ship_id = $1', [shipId]);
    if (!rowCount) return res.status(404).json({ error: 'Ship not found' });
    res.json({ message: 'Ship deleted' });
  } catch (err) {
    console.error('Error deleting ship:', err);
    res.status(500).json({ error: 'Failed to delete ship' });
  }
};

// GET /ships/company/:company_id
// SuperAdmin only: get ships filtered by company_id
export const getShipsByCompanyId = async (req, res) => {
  try {
    const { role_id } = req.user;
    if (Number(role_id) !== ROLE_SUPERADMIN) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const companyId = String(req.params.company_id || "").trim();
    if (!companyId) return res.status(400).json({ error: "company_id is required" });

    const { rows } = await db.query(
      "SELECT * FROM ships WHERE company_id = $1 ORDER BY ship_id",
      [companyId]
    );

    return res.json(rows);
  } catch (err) {
    console.error("Error getting ships by company:", err);
    return res.status(500).json({ error: "Failed to fetch ships" });
  }
};

