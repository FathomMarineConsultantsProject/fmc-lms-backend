// src/controller/incidentsController.js
import { db } from '../db.js';

// GET /incidents
// Optional visibility filter: /incidents?user_id=5
export const getAllIncidents = async (req, res) => {
  const userId = req.query.user_id ? parseInt(req.query.user_id, 10) : null;

  try {
    // If user_id is provided, apply visibility logic:
    // - incidents of user's ship always visible
    // - incidents of user's company visible ONLY if visible_to_ship_only is false
    if (userId) {
      if (Number.isNaN(userId)) {
        return res.status(400).json({ error: 'user_id must be a number' });
      }

      const { rows } = await db.query(
        `
        SELECT ir.*
        FROM incident_reports ir
        JOIN users u ON u.user_id = $1
        WHERE ir.is_deleted IS NOT TRUE
          AND (
            ir.ship_id = u.ship_id
            OR (ir.company_id = u.company_id AND ir.visible_to_ship_only IS NOT TRUE)
          )
        ORDER BY ir.occurred_at DESC NULLS LAST, ir.incident_id DESC
        `,
        [userId]
      );

      return res.json(rows);
    }

    // No user filter = return all (admin/dev)
    const { rows } = await db.query(
      `
      SELECT *
      FROM incident_reports
      WHERE is_deleted IS NOT TRUE
      ORDER BY occurred_at DESC NULLS LAST, incident_id DESC
      `
    );

    res.json(rows);
  } catch (err) {
    console.error('Error getting incidents:', err);
    res.status(500).json({ error: 'Failed to fetch incidents' });
  }
};

// GET /incidents/:id
export const getIncidentById = async (req, res) => {
  const incidentId = parseInt(req.params.id, 10);
  if (Number.isNaN(incidentId)) {
    return res.status(400).json({ error: 'incident_id must be a number' });
  }

  try {
    const { rows } = await db.query(
      `
      SELECT *
      FROM incident_reports
      WHERE incident_id = $1
        AND is_deleted IS NOT TRUE
      `,
      [incidentId]
    );

    if (!rows.length) return res.status(404).json({ error: 'Incident not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error('Error getting incident:', err);
    res.status(500).json({ error: 'Failed to fetch incident' });
  }
};

// POST /incidents
export const createIncident = async (req, res) => {
  const {
    ship_id,
    company_id, // optional: if omitted, we’ll auto-fill from ships.company_id
    reported_by_user_id,
    visible_to_ship_only,
    title,
    description,
    incident_type,
    severity,
    location_on_ship,
    root_cause,
    corrective_action,
    preventive_action,
    status,
    occurred_at,
    reported_at,
    closed_at,
    reference_code,
  } = req.body;

  const shipId = parseInt(ship_id, 10);
  const reporterId = parseInt(reported_by_user_id, 10);

  if (Number.isNaN(shipId) || Number.isNaN(reporterId)) {
    return res.status(400).json({ error: 'ship_id and reported_by_user_id must be numbers' });
  }
  if (!title) {
    return res.status(400).json({ error: 'title is required' });
  }

  try {
    // 1) validate ship exists + get ship.company_id (UUID)
    const shipRes = await db.query(
      `SELECT ship_id, company_id FROM ships WHERE ship_id = $1`,
      [shipId]
    );
    if (!shipRes.rows.length) return res.status(404).json({ error: 'Ship not found' });

    const shipCompanyId = shipRes.rows[0].company_id; // UUID string

    // 2) ensure incident company_id matches the ship’s company_id
    const finalCompanyId = company_id ? String(company_id) : shipCompanyId;
    if (finalCompanyId !== shipCompanyId) {
      return res.status(400).json({
        error: `company_id mismatch: ship_id ${shipId} belongs to company_id ${shipCompanyId}`,
      });
    }

    // 3) validate reporter exists
    const userRes = await db.query(
      `SELECT user_id, ship_id, company_id FROM users WHERE user_id = $1`,
      [reporterId]
    );
    if (!userRes.rows.length) return res.status(404).json({ error: 'Reporting user not found' });

    // 4) authorization-like check: reporter must belong to same ship OR company
    const reporter = userRes.rows[0];
    const sameShip = reporter.ship_id === shipId;
    const sameCompany = reporter.company_id === finalCompanyId;

    if (!sameShip && !sameCompany) {
      return res.status(403).json({
        error: 'User cannot report incident for a ship/company they do not belong to',
      });
    }

    // 5) insert
    const { rows } = await db.query(
      `
      INSERT INTO incident_reports (
        ship_id,
        company_id,
        reported_by_user_id,
        visible_to_ship_only,
        title,
        description,
        incident_type,
        severity,
        location_on_ship,
        root_cause,
        corrective_action,
        preventive_action,
        status,
        occurred_at,
        reported_at,
        closed_at,
        reference_code,
        is_deleted,
        created_at,
        updated_at
      )
      VALUES (
        $1, $2, $3,
        COALESCE($4, false),
        $5, $6, $7, $8, $9, $10, $11, $12,
        COALESCE($13, 'Reported'),
        $14,
        COALESCE($15, NOW()),
        $16,
        $17,
        false,
        NOW(),
        NOW()
      )
      RETURNING *
      `,
      [
        shipId,
        finalCompanyId,
        reporterId,
        visible_to_ship_only,
        title,
        description || null,
        incident_type || null,
        severity || null,
        location_on_ship || null,
        root_cause || null,
        corrective_action || null,
        preventive_action || null,
        status || null,
        occurred_at || null,
        reported_at || null,
        closed_at || null,
        reference_code || null,
      ]
    );

    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('Error creating incident:', err);

    // FK violation (safety net)
    if (err.code === '23503') {
      return res.status(400).json({ error: 'Foreign key constraint failed (check ship/company/user IDs)' });
    }

    res.status(500).json({ error: 'Failed to create incident' });
  }
};

// PUT /incidents/:id
export const updateIncident = async (req, res) => {
  const incidentId = parseInt(req.params.id, 10);
  if (Number.isNaN(incidentId)) {
    return res.status(400).json({ error: 'incident_id must be a number' });
  }

  const {
    ship_id,
    company_id,
    reported_by_user_id,
    visible_to_ship_only,
    title,
    description,
    incident_type,
    severity,
    location_on_ship,
    root_cause,
    corrective_action,
    preventive_action,
    status,
    occurred_at,
    reported_at,
    closed_at,
    reference_code,
    is_deleted,
  } = req.body;

  try {
    // If ship_id is provided, enforce company_id consistency (UUID)
    let finalCompanyId = company_id ? String(company_id) : null;

    if (ship_id) {
      const shipId = parseInt(ship_id, 10);
      if (Number.isNaN(shipId)) return res.status(400).json({ error: 'ship_id must be a number' });

      const shipRes = await db.query(`SELECT company_id FROM ships WHERE ship_id = $1`, [shipId]);
      if (!shipRes.rows.length) return res.status(404).json({ error: 'Ship not found' });

      const shipCompanyId = shipRes.rows[0].company_id;

      // If company_id provided, it must match
      if (finalCompanyId && finalCompanyId !== shipCompanyId) {
        return res.status(400).json({
          error: `company_id mismatch: ship_id ${shipId} belongs to company_id ${shipCompanyId}`,
        });
      }

      // If company_id not provided, auto-fill from ship
      if (!finalCompanyId) finalCompanyId = shipCompanyId;
    }

    const { rowCount } = await db.query(
      `
      UPDATE incident_reports
      SET
        ship_id              = COALESCE($1, ship_id),
        company_id           = COALESCE($2, company_id),
        reported_by_user_id  = COALESCE($3, reported_by_user_id),
        visible_to_ship_only = COALESCE($4, visible_to_ship_only),
        title                = COALESCE($5, title),
        description          = COALESCE($6, description),
        incident_type        = COALESCE($7, incident_type),
        severity             = COALESCE($8, severity),
        location_on_ship     = COALESCE($9, location_on_ship),
        root_cause           = COALESCE($10, root_cause),
        corrective_action    = COALESCE($11, corrective_action),
        preventive_action    = COALESCE($12, preventive_action),
        status               = COALESCE($13, status),
        occurred_at          = COALESCE($14, occurred_at),
        reported_at          = COALESCE($15, reported_at),
        closed_at            = COALESCE($16, closed_at),
        reference_code       = COALESCE($17, reference_code),
        is_deleted           = COALESCE($18, is_deleted),
        updated_at           = NOW()
      WHERE incident_id = $19
      `,
      [
        ship_id ?? null,
        finalCompanyId ?? null,
        reported_by_user_id ?? null,
        visible_to_ship_only ?? null,
        title ?? null,
        description ?? null,
        incident_type ?? null,
        severity ?? null,
        location_on_ship ?? null,
        root_cause ?? null,
        corrective_action ?? null,
        preventive_action ?? null,
        status ?? null,
        occurred_at ?? null,
        reported_at ?? null,
        closed_at ?? null,
        reference_code ?? null,
        is_deleted ?? null,
        incidentId,
      ]
    );

    if (!rowCount) return res.status(404).json({ error: 'Incident not found' });
    res.json({ message: 'Incident updated' });
  } catch (err) {
    console.error('Error updating incident:', err);
    res.status(500).json({ error: 'Failed to update incident' });
  }
};

// DELETE /incidents/:id  (soft delete)
export const deleteIncident = async (req, res) => {
  const incidentId = parseInt(req.params.id, 10);
  if (Number.isNaN(incidentId)) {
    return res.status(400).json({ error: 'incident_id must be a number' });
  }

  try {
    const { rowCount } = await db.query(
      `
      UPDATE incident_reports
      SET is_deleted = true,
          updated_at = NOW()
      WHERE incident_id = $1
      `,
      [incidentId]
    );

    if (!rowCount) return res.status(404).json({ error: 'Incident not found' });
    res.json({ message: 'Incident deleted (soft delete)' });
  } catch (err) {
    console.error('Error deleting incident:', err);
    res.status(500).json({ error: 'Failed to delete incident' });
  }
};
