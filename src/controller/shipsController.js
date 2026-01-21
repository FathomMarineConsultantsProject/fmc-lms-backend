// src/controller/shipsController.js
import { db } from '../db.js';

const ROLE_SUPERADMIN = 1;
const ROLE_ADMIN = 2;
const ROLE_SUBADMIN = 3;
const ROLE_CREW = 4;

const canWriteShips = (roleId) => roleId === ROLE_SUPERADMIN || roleId === ROLE_ADMIN;

const isUuid = (v) =>
  typeof v === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);

const parsePositiveInt = (v, def) => {
  const n = Number.parseInt(String(v ?? ""), 10);
  return Number.isFinite(n) && n > 0 ? n : def;
};

export const getAllShips = async (req, res) => {
  try {
    const roleId = Number(req.user?.role_id);
    const myCompanyId = req.user?.company_id ? String(req.user.company_id) : null;
    const myShipId = req.user?.ship_id != null ? Number(req.user.ship_id) : null;

    // query params
    const queryCompanyIdRaw = req.query?.company_id;
    const qRaw = req.query?.q;
    const includeCounts = String(req.query?.include_counts || "").toLowerCase() === "true";

    const page = parsePositiveInt(req.query?.page, 1);
    const limit = Math.min(parsePositiveInt(req.query?.limit, 200), 500); // cap
    const offset = (page - 1) * limit;

    // ---------------- Role 3/4: only their ship ----------------
    if (roleId === ROLE_SUBADMIN || roleId === ROLE_CREW) {
      if (!myShipId) return res.json({ page: 1, limit, total: 0, rows: [] });

      const { rows } = await db.query(
        `SELECT * FROM ships WHERE ship_id = $1 ORDER BY ship_id`,
        [myShipId]
      );

      return res.json({ page: 1, limit, total: rows.length, rows });
    }

    // ---------------- Role 1/2: list ships (with filters) ----------------
    const where = [];
    const params = [];
    let p = 1;

    // company scope
    if (roleId === ROLE_ADMIN) {
      // role2 is forced to their own company always
      if (!myCompanyId) return res.json({ page, limit, total: 0, rows: [] });
      where.push(`s.company_id = $${p++}`);
      params.push(myCompanyId);
    } else if (roleId === ROLE_SUPERADMIN) {
      // superadmin can optionally filter by company_id
      if (queryCompanyIdRaw != null && String(queryCompanyIdRaw).trim() !== "") {
        const queryCompanyId = String(queryCompanyIdRaw).trim();
        if (!isUuid(queryCompanyId)) {
          return res.status(400).json({ error: "company_id must be a valid UUID" });
        }
        where.push(`s.company_id = $${p++}`);
        params.push(queryCompanyId);
      }
    } else {
      // unknown role
      return res.status(403).json({ error: "Forbidden" });
    }

    // search filter
    const q = qRaw != null ? String(qRaw).trim() : "";
    if (q) {
      where.push(
        `(s.ship_name ILIKE $${p} OR s.imo_number ILIKE $${p})`
      );
      params.push(`%${q}%`);
      p++;
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    // ---- optional: include crew counts per ship ----
    // Note: this uses users table; status assumed Onboard/Offboard.
    // If you use Active/Paused, change the CASE conditions accordingly.
    const selectSql = includeCounts
      ? `
        SELECT
          s.*,
          COUNT(u.user_id) FILTER (WHERE u.user_id IS NOT NULL) AS crew_total,
          COUNT(u.user_id) FILTER (WHERE lower(u.status) = 'onboard') AS crew_onboard,
          COUNT(u.user_id) FILTER (WHERE lower(u.status) = 'offboard') AS crew_offboard
        FROM ships s
        LEFT JOIN users u
          ON u.ship_id = s.ship_id
      `
      : `
        SELECT s.*
        FROM ships s
      `;

    const groupSql = includeCounts ? `GROUP BY s.ship_id` : ``;

    // total count for pagination (distinct ships)
    const totalRes = await db.query(
      `SELECT COUNT(*)::int AS total
       FROM ships s
       ${whereSql}`,
      params
    );
    const total = totalRes.rows[0]?.total ?? 0;

    // data query
    const dataParams = [...params, limit, offset];
    const { rows } = await db.query(
      `
      ${selectSql}
      ${whereSql}
      ${groupSql}
      ORDER BY s.ship_id
      LIMIT $${p++} OFFSET $${p++}
      `,
      dataParams
    );

    return res.json({ page, limit, total, rows });
  } catch (err) {
    console.error("Error getting ships:", err);
    return res.status(500).json({ error: "Failed to fetch ships" });
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
    if (Number.isNaN(shipId)) return res.status(400).json({ error: "ship_id must be a number" });

    const { role_id, company_id, ship_id } = req.user;

    const shipRes = await db.query("SELECT * FROM ships WHERE ship_id = $1", [shipId]);
    if (!shipRes.rows.length) return res.status(404).json({ error: "Ship not found" });

    const ship = shipRes.rows[0];

    if (role_id === ROLE_SUPERADMIN) return res.json(ship);

    if (role_id === ROLE_ADMIN) {
      if (String(ship.company_id) !== String(company_id)) {
        return res.status(403).json({ error: "Forbidden (company scope)" });
      }
      return res.json(ship);
    }

    if (role_id === ROLE_SUBADMIN) {
      if (Number(shipId) !== Number(ship_id)) {
        return res.status(403).json({ error: "Forbidden (ship scope)" });
      }
      return res.json(ship);
    }

    return res.status(403).json({ error: "Forbidden" });
  } catch (err) {
    console.error("Error getting ship:", err);
    return res.status(500).json({ error: "Failed to fetch ship" });
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
  if (!canWriteShips(role_id)) return res.status(403).json({ error: "Forbidden" });

  const shipId = parseInt(req.params.id, 10);
  if (Number.isNaN(shipId)) return res.status(400).json({ error: "ship_id must be a number" });

  try {
    // fetch current ship for scope check
    const current = await db.query("SELECT company_id FROM ships WHERE ship_id = $1", [shipId]);
    if (!current.rows.length) return res.status(404).json({ error: "Ship not found" });

    const shipCompanyId = current.rows[0].company_id;

    // role2 can only update ships in their company
    if (role_id === ROLE_ADMIN && String(shipCompanyId) !== String(company_id)) {
      return res.status(403).json({ error: "Forbidden (company scope)" });
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
      company_id: newCompanyId, // incoming attempt
    } = req.body;

    // 🔒 role2 cannot change company_id EVER
    if (role_id === ROLE_ADMIN && newCompanyId && String(newCompanyId) !== String(shipCompanyId)) {
      return res.status(403).json({ error: "Forbidden (cannot change company_id)" });
    }

    // ✅ Set company_id only for role1, otherwise keep existing
    const companyIdToSet = role_id === ROLE_SUPERADMIN ? (newCompanyId ?? null) : null;

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
        ship_name ?? null,
        imo_number ?? null,
        flag ?? null,
        ship_class ?? null,
        owner ?? null,
        validity ?? null,
        ship_type ?? null,
        capacity ?? null,
        powered_by ?? null,
        companyIdToSet, // role1 can set, role2 passes null => stays unchanged
        shipId,
      ]
    );

    if (!rowCount) return res.status(404).json({ error: "Ship not found" });
    return res.json({ message: "Ship updated" });
  } catch (err) {
    console.error("Error updating ship:", err);
    return res.status(500).json({ error: "Failed to update ship" });
  }
};

//DELETE SHIP
export const deleteShip = async (req, res) => {
  const { role_id, company_id } = req.user;
  if (!canWriteShips(role_id)) return res.status(403).json({ error: "Forbidden" });

  const shipId = parseInt(req.params.id, 10);
  if (Number.isNaN(shipId)) return res.status(400).json({ error: "ship_id must be a number" });

  try {
    const current = await db.query("SELECT company_id FROM ships WHERE ship_id = $1", [shipId]);
    if (!current.rows.length) return res.status(404).json({ error: "Ship not found" });

    if (role_id === ROLE_ADMIN && String(current.rows[0].company_id) !== String(company_id)) {
      return res.status(403).json({ error: "Forbidden (company scope)" });
    }

    const { rowCount } = await db.query("DELETE FROM ships WHERE ship_id = $1", [shipId]);
    if (!rowCount) return res.status(404).json({ error: "Ship not found" });

    return res.json({ message: "Ship deleted" });
  } catch (err) {
    console.error("Error deleting ship:", err);
    return res.status(500).json({ error: "Failed to delete ship" });
  }
};

// GET /ships/company/:company_id
// SuperAdmin only: get ships filtered by company_id
// GET /ships/company/:company_id?page=1&limit=50&q=sea
export const getShipsByCompanyId = async (req, res) => {
  try {
    const { role_id } = req.user;
    if (Number(role_id) !== ROLE_SUPERADMIN) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const companyId = String(req.params.company_id || "").trim();
    if (!companyId) return res.status(400).json({ error: "company_id is required" });
    if (!isUuid(companyId)) return res.status(400).json({ error: "company_id must be a valid UUID" });

    const q = String(req.query.q ?? "").trim();
    const { page, limit, offset } = (() => {
      // shipsController doesn't have your getPagination helper, so keep style similar:
      const p = parsePositiveInt(req.query?.page, 1);
      const l = Math.min(Math.max(parsePositiveInt(req.query?.limit, 50), 10), 100); // min10 max100
      return { page: p, limit: l, offset: (p - 1) * l };
    })();

    const where = [`s.company_id = $1`];
    const params = [companyId];
    let idx = 2;

    if (q) {
      where.push(`(s.ship_name ILIKE $${idx} OR s.imo_number ILIKE $${idx})`);
      params.push(`%${q}%`);
      idx++;
    }

    const whereSql = `WHERE ${where.join(" AND ")}`;

    const totalRes = await db.query(
      `SELECT COUNT(*)::int AS total
       FROM ships s
       ${whereSql}`,
      params
    );
    const total = totalRes.rows[0]?.total ?? 0;

    const dataParams = [...params, limit, offset];
    const { rows } = await db.query(
      `SELECT s.*
       FROM ships s
       ${whereSql}
       ORDER BY s.ship_id
       LIMIT $${idx} OFFSET $${idx + 1}`,
      dataParams
    );

    return res.json({ company_id: companyId, page, limit, total, count: rows.length, rows });
  } catch (err) {
    console.error("Error getting ships by company:", err);
    return res.status(500).json({ error: "Failed to fetch ships" });
  }
};
