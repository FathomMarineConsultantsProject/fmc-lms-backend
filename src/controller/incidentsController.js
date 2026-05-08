// src/controller/incidentsController.js
import { db } from "../db.js";

const ROLE_SUPERADMIN = 1;
const ROLE_ADMIN = 2;
const ROLE_SUBADMIN = 3;
const ROLE_CREW = 4;

const isUuid = (v) =>
  typeof v === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{12}$/i.test(v);

const buildIncidentListQuery = (user) => {
  const { role_id, company_id, ship_id } = user;

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
};

const canAccessIncident = (user, incident) => {
  if (user.role_id === ROLE_SUPERADMIN) return true;

  if (user.role_id === ROLE_ADMIN) {
    return String(incident.company_id) === String(user.company_id);
  }

  return (
    String(incident.company_id) === String(user.company_id) &&
    Number(incident.ship_id) === Number(user.ship_id)
  );
};

const canModifyIncident = (user, incident) => {
  if (!canAccessIncident(user, incident)) return false;

  if (user.role_id === ROLE_CREW) {
    return Number(incident.reported_by_user_id) === Number(user.user_id);
  }

  return true;
};

export const getAllIncidents = async (req, res) => {
  try {
    const q = buildIncidentListQuery(req.user);
    const { rows } = await db.query(q.text, q.values);
    res.json(rows);
  } catch (err) {
    console.error("Error getting incidents:", err);
    res.status(500).json({ error: "Failed to fetch incidents" });
  }
};

export const getIncidentById = async (req, res) => {
  const incidentId = req.params.id;

  if (!isUuid(incidentId)) {
    return res.status(400).json({ error: "incident_id must be a UUID" });
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

    if (!rows.length) {
      return res.status(404).json({ error: "Incident not found" });
    }

    const incident = rows[0];

    if (!canAccessIncident(req.user, incident)) {
      return res.status(403).json({ error: "Forbidden" });
    }

    res.json(incident);
  } catch (err) {
    console.error("Error getting incident:", err);
    res.status(500).json({ error: "Failed to fetch incident" });
  }
};

export const createIncident = async (req, res) => {
  const {
    ship_id,
    visible_to_ship_only,
    title,
    description,
    incident_type,
    severity,
    priority,
    location_on_ship,
    immediate_action,
    root_cause,
    lesson_learned,
    corrective_action,
    preventive_action,
    status,
    occurred_at,
    reported_at,
    closed_at,
    reference_code,
  } = req.body;

  const shipId = parseInt(ship_id, 10);

  if (Number.isNaN(shipId)) {
    return res.status(400).json({ error: "ship_id must be a number" });
  }

  if (!title?.trim()) {
    return res.status(400).json({ error: "title is required" });
  }

  const { role_id, company_id: myCompanyId, ship_id: myShipId, user_id: myUserId } = req.user;

  try {
    const shipRes = await db.query(
      `SELECT ship_id, company_id FROM ships WHERE ship_id = $1`,
      [shipId]
    );

    if (!shipRes.rows.length) {
      return res.status(404).json({ error: "Ship not found" });
    }

    const shipCompanyId = shipRes.rows[0].company_id;

    if (role_id === ROLE_ADMIN && String(shipCompanyId) !== String(myCompanyId)) {
      return res.status(403).json({ error: "Forbidden: ship is outside your company" });
    }

    if (
      (role_id === ROLE_SUBADMIN || role_id === ROLE_CREW) &&
      (String(shipCompanyId) !== String(myCompanyId) || Number(shipId) !== Number(myShipId))
    ) {
      return res.status(403).json({ error: "Forbidden: ship is outside your scope" });
    }

    const reporterId = myUserId;

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
        priority,
        location_on_ship,
        immediate_action,
        root_cause,
        lesson_learned,
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
        COALESCE($4, true),
        $5, $6, $7, $8, $9, $10,
        $11, $12, $13, $14, $15,
        COALESCE($16, 'Reported'),
        $17,
        COALESCE($18, NOW()),
        $19,
        $20,
        false,
        NOW(),
        NOW()
      )
      RETURNING *
      `,
      [
        shipId,
        shipCompanyId,
        reporterId,
        visible_to_ship_only,
        title.trim(),
        description || null,
        incident_type || null,
        severity || null,
        priority || null,
        location_on_ship || null,
        immediate_action || null,
        root_cause || null,
        lesson_learned || null,
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
    console.error("Error creating incident:", err);
    res.status(500).json({ error: "Failed to create incident" });
  }
};

export const updateIncident = async (req, res) => {
  const incidentId = req.params.id;

  if (!isUuid(incidentId)) {
    return res.status(400).json({ error: "incident_id must be a UUID" });
  }

  try {
    const currentRes = await db.query(
      `
      SELECT *
      FROM incident_reports
      WHERE incident_id = $1
        AND is_deleted IS NOT TRUE
      `,
      [incidentId]
    );

    if (!currentRes.rows.length) {
      return res.status(404).json({ error: "Incident not found" });
    }

    const incident = currentRes.rows[0];

    if (!canModifyIncident(req.user, incident)) {
      return res.status(403).json({ error: "Forbidden" });
    }

    if (req.body.ship_id || req.body.company_id || req.body.reported_by_user_id) {
      return res.status(400).json({
        error: "ship_id, company_id and reported_by_user_id cannot be changed",
      });
    }

    const {
      visible_to_ship_only,
      title,
      description,
      incident_type,
      severity,
      priority,
      location_on_ship,
      immediate_action,
      root_cause,
      lesson_learned,
      corrective_action,
      preventive_action,
      status,
      occurred_at,
      reported_at,
      closed_at,
      reference_code,
    } = req.body;

    const { rows } = await db.query(
      `
      UPDATE incident_reports
      SET
        visible_to_ship_only = COALESCE($1, visible_to_ship_only),
        title                = COALESCE($2, title),
        description          = COALESCE($3, description),
        incident_type        = COALESCE($4, incident_type),
        severity             = COALESCE($5, severity),
        priority             = COALESCE($6, priority),
        location_on_ship     = COALESCE($7, location_on_ship),
        immediate_action     = COALESCE($8, immediate_action),
        root_cause           = COALESCE($9, root_cause),
        lesson_learned       = COALESCE($10, lesson_learned),
        corrective_action    = COALESCE($11, corrective_action),
        preventive_action    = COALESCE($12, preventive_action),
        status               = COALESCE($13, status),
        occurred_at          = COALESCE($14, occurred_at),
        reported_at          = COALESCE($15, reported_at),
        closed_at            = COALESCE($16, closed_at),
        reference_code       = COALESCE($17, reference_code),
        updated_at           = NOW()
      WHERE incident_id = $18
        AND is_deleted IS NOT TRUE
      RETURNING *
      `,
      [
        visible_to_ship_only ?? null,
        title?.trim() || null,
        description ?? null,
        incident_type ?? null,
        severity ?? null,
        priority ?? null,
        location_on_ship ?? null,
        immediate_action ?? null,
        root_cause ?? null,
        lesson_learned ?? null,
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

    res.json(rows[0]);
  } catch (err) {
    console.error("Error updating incident:", err);
    res.status(500).json({ error: "Failed to update incident" });
  }
};

export const deleteIncident = async (req, res) => {
  const incidentId = req.params.id;

  if (!isUuid(incidentId)) {
    return res.status(400).json({ error: "incident_id must be a UUID" });
  }

  try {
    const currentRes = await db.query(
      `
      SELECT *
      FROM incident_reports
      WHERE incident_id = $1
        AND is_deleted IS NOT TRUE
      `,
      [incidentId]
    );

    if (!currentRes.rows.length) {
      return res.status(404).json({ error: "Incident not found" });
    }

    const incident = currentRes.rows[0];

    if (!canModifyIncident(req.user, incident)) {
      return res.status(403).json({ error: "Forbidden" });
    }

    await db.query(
      `
      UPDATE incident_reports
      SET is_deleted = true,
          updated_at = NOW()
      WHERE incident_id = $1
      `,
      [incidentId]
    );

    res.json({ message: "Incident deleted successfully" });
  } catch (err) {
    console.error("Error deleting incident:", err);
    res.status(500).json({ error: "Failed to delete incident" });
  }
};