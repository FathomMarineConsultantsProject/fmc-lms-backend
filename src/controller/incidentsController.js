// src/controller/incidentsController.js
import { db } from '../db.js';

const ROLE_SUPERADMIN = 1;
const ROLE_ADMIN = 2;
const ROLE_SUBADMIN = 3;
const ROLE_CREW = 4;

const isUuid = (v) =>
  typeof v === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);

const buildIncidentListQuery = (user) => {
  const { role_id, company_id, ship_id, user_id } = user;

  if (role_id === ROLE_SUPERADMIN) {
    return {
      text: `
        SELECT *
        FROM incident_reports
        WHERE is_deleted IS NOT TRUE
        ORDER BY occurred_at DESC NULLS LAST, created_at DESC
      `,
      values: [],
    };
  }

  if (role_id === ROLE_ADMIN) {
    return {
      text: `
        SELECT *
        FROM incident_reports
        WHERE is_deleted IS NOT TRUE
          AND company_id = $1
        ORDER BY occurred_at DESC NULLS LAST, created_at DESC
      `,
      values: [company_id],
    };
  }

  if (role_id === ROLE_SUBADMIN) {
    return {
      text: `
        SELECT *
        FROM incident_reports
        WHERE is_deleted IS NOT TRUE
          AND company_id = $1
          AND ship_id = $2
        ORDER BY occurred_at DESC NULLS LAST, created_at DESC
      `,
      values: [company_id, ship_id],
    };
  }

  // role4 crew
  return {
    text: `
      SELECT *
      FROM incident_reports
      WHERE is_deleted IS NOT TRUE
        AND (
          reported_by_user_id = $1
          OR (
            ship_id = $2
            AND visible_to_ship_only IS TRUE
          )
          OR (
            company_id = $3
            AND (visible_to_ship_only IS NOT TRUE)
          )
        )
      ORDER BY occurred_at DESC NULLS LAST, created_at DESC
    `,
    values: [user_id, ship_id, company_id],
  };
};

const canSeeIncident = (user, incident) => {
  const { role_id, company_id, ship_id, user_id } = user;

  if (role_id === ROLE_SUPERADMIN) return true;

  if (role_id === ROLE_ADMIN) {
    return String(incident.company_id) === String(company_id);
  }

  if (role_id === ROLE_SUBADMIN) {
    return (
      String(incident.company_id) === String(company_id) &&
      Number(incident.ship_id) === Number(ship_id)
    );
  }

  // crew
  if (Number(incident.reported_by_user_id) === Number(user_id)) return true;

  if (Number(incident.ship_id) === Number(ship_id) && incident.visible_to_ship_only === true) {
    return true;
  }

  if (String(incident.company_id) === String(company_id) && incident.visible_to_ship_only !== true) {
    return true;
  }

  return false;
};

// GET /incidents
export const getAllIncidents = async (req, res) => {
  try {
    const q = buildIncidentListQuery(req.user);
    const { rows } = await db.query(q.text, q.values);
    res.json(rows);
  } catch (err) {
    console.error('Error getting incidents:', err);
    res.status(500).json({ error: 'Failed to fetch incidents' });
  }
};

// GET /incidents/:id
export const getIncidentById = async (req, res) => {
  const incidentId = req.params.id;
  if (!isUuid(incidentId)) return res.status(400).json({ error: 'incident_id must be a UUID' });

  try {
    const { rows } = await db.query(
      `SELECT * FROM incident_reports
       WHERE incident_id = $1 AND is_deleted IS NOT TRUE`,
      [incidentId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Incident not found' });

    const incident = rows[0];
    if (!canSeeIncident(req.user, incident)) return res.status(403).json({ error: 'Forbidden' });

    res.json(incident);
  } catch (err) {
    console.error('Error getting incident:', err);
    res.status(500).json({ error: 'Failed to fetch incident' });
  }
};

// POST /incidents
export const createIncident = async (req, res) => {
  const {
    ship_id,
    company_id,
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
  if (Number.isNaN(shipId)) return res.status(400).json({ error: 'ship_id must be a number' });
  if (!title) return res.status(400).json({ error: 'title is required' });

  const { role_id, company_id: myCompanyId, ship_id: myShipId, user_id: myUserId } = req.user;

  try {
    // ship must exist
    const shipRes = await db.query(`SELECT ship_id, company_id FROM ships WHERE ship_id = $1`, [shipId]);
    if (!shipRes.rows.length) return res.status(404).json({ error: 'Ship not found' });

    const shipCompanyId = shipRes.rows[0].company_id;
    const finalCompanyId = company_id ? String(company_id) : String(shipCompanyId);

    if (String(finalCompanyId) !== String(shipCompanyId)) {
      return res.status(400).json({ error: 'company_id mismatch with ship.company_id' });
    }

    // scope rules
    if (role_id === ROLE_ADMIN) {
      if (String(finalCompanyId) !== String(myCompanyId)) {
        return res.status(403).json({ error: 'Forbidden (company scope)' });
      }
    }

    if (role_id === ROLE_SUBADMIN || role_id === ROLE_CREW) {
      if (String(finalCompanyId) !== String(myCompanyId) || Number(shipId) !== Number(myShipId)) {
        return res.status(403).json({ error: 'Forbidden (ship scope)' });
      }
    }

    // reporter forced for everyone except superadmin (superadmin may specify)
    const reporterId =
      role_id === ROLE_SUPERADMIN && req.body.reported_by_user_id
        ? parseInt(req.body.reported_by_user_id, 10)
        : myUserId;

    const { rows } = await db.query(
      `
      INSERT INTO incident_reports (
        ship_id, company_id, reported_by_user_id,
        visible_to_ship_only, title, description,
        incident_type, severity, location_on_ship,
        root_cause, corrective_action, preventive_action,
        status, occurred_at, reported_at, closed_at,
        reference_code, is_deleted, created_at, updated_at
      )
      VALUES (
        $1, $2, $3,
        COALESCE($4, false),
        $5, $6,
        $7, $8, $9,
        $10, $11, $12,
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
    if (err.code === '23503') {
      return res.status(400).json({ error: 'Foreign key constraint failed' });
    }
    res.status(500).json({ error: 'Failed to create incident' });
  }
};

// PUT /incidents/:id
export const updateIncident = async (req, res) => {
  const incidentId = req.params.id;
  if (!isUuid(incidentId)) return res.status(400).json({ error: 'incident_id must be a UUID' });

  try {
    const currentRes = await db.query(
      `SELECT * FROM incident_reports WHERE incident_id = $1 AND is_deleted IS NOT TRUE`,
      [incidentId]
    );
    if (!currentRes.rows.length) return res.status(404).json({ error: 'Incident not found' });

    const incident = currentRes.rows[0];

    // authorize
    if (!canSeeIncident(req.user, incident)) return res.status(403).json({ error: 'Forbidden' });

    // crew can only update their own reported incidents
    if (req.user.role_id === ROLE_CREW && Number(incident.reported_by_user_id) !== Number(req.user.user_id)) {
      return res.status(403).json({ error: 'Forbidden (only own incident)' });
    }

    // prevent lower roles from moving incident to other ship/company
    const nextShipId = req.body.ship_id ? parseInt(req.body.ship_id, 10) : null;
    const nextCompanyId = req.body.company_id ? String(req.body.company_id) : null;

    if ((req.user.role_id === ROLE_ADMIN || req.user.role_id === ROLE_SUBADMIN || req.user.role_id === ROLE_CREW) &&
        (nextShipId || nextCompanyId)) {
      // they must remain in their scope
      const mustCompany = String(req.user.company_id);
      const mustShip = req.user.ship_id;

      if (nextCompanyId && String(nextCompanyId) !== mustCompany) {
        return res.status(403).json({ error: 'Forbidden (cannot change company_id)' });
      }
      if ((req.user.role_id === ROLE_SUBADMIN || req.user.role_id === ROLE_CREW) && nextShipId && Number(nextShipId) !== Number(mustShip)) {
        return res.status(403).json({ error: 'Forbidden (cannot change ship_id)' });
      }
    }

    const {
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

    const { rowCount } = await db.query(
      `
      UPDATE incident_reports
      SET
        visible_to_ship_only = COALESCE($1, visible_to_ship_only),
        title                = COALESCE($2, title),
        description          = COALESCE($3, description),
        incident_type        = COALESCE($4, incident_type),
        severity             = COALESCE($5, severity),
        location_on_ship     = COALESCE($6, location_on_ship),
        root_cause           = COALESCE($7, root_cause),
        corrective_action    = COALESCE($8, corrective_action),
        preventive_action    = COALESCE($9, preventive_action),
        status               = COALESCE($10, status),
        occurred_at          = COALESCE($11, occurred_at),
        reported_at          = COALESCE($12, reported_at),
        closed_at            = COALESCE($13, closed_at),
        reference_code       = COALESCE($14, reference_code),
        updated_at           = NOW()
      WHERE incident_id = $15
      `,
      [
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

// DELETE /incidents/:id (soft delete)
export const deleteIncident = async (req, res) => {
  const incidentId = req.params.id;
  if (!isUuid(incidentId)) return res.status(400).json({ error: 'incident_id must be a UUID' });

  try {
    const currentRes = await db.query(
      `SELECT * FROM incident_reports WHERE incident_id = $1 AND is_deleted IS NOT TRUE`,
      [incidentId]
    );
    if (!currentRes.rows.length) return res.status(404).json({ error: 'Incident not found' });

    const incident = currentRes.rows[0];

    if (!canSeeIncident(req.user, incident)) return res.status(403).json({ error: 'Forbidden' });

    // crew can only delete their own incident
    if (req.user.role_id === ROLE_CREW && Number(incident.reported_by_user_id) !== Number(req.user.user_id)) {
      return res.status(403).json({ error: 'Forbidden (only own incident)' });
    }

    const { rowCount } = await db.query(
      `UPDATE incident_reports
       SET is_deleted = true, updated_at = NOW()
       WHERE incident_id = $1`,
      [incidentId]
    );

    if (!rowCount) return res.status(404).json({ error: 'Incident not found' });
    res.json({ message: 'Incident deleted (soft delete)' });
  } catch (err) {
    console.error('Error deleting incident:', err);
    res.status(500).json({ error: 'Failed to delete incident' });
  }
};
