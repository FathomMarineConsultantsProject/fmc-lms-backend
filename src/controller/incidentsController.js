// src/controller/incidentsController.js
import { db } from "../db.js";
import validator from "validator";
import { generateIncidentDashboard } from "./aiController.js";

const ROLE_SUPERADMIN = 1;
const ROLE_ADMIN = 2;
const ROLE_SUBADMIN = 3;
const ROLE_CREW = 4;

const isUuid = (v) => validator.isUUID(v + "");

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
    const { role_id, company_id, ship_id } = req.user;

    let queryText = `
      SELECT
        ir.*,
        CASE
          WHEN ird.incident_id IS NULL THEN NULL
          ELSE to_jsonb(ird)
        END AS details
      FROM incident_reports ir
      LEFT JOIN incident_report_details ird
        ON ird.incident_id = ir.incident_id
      WHERE ir.is_deleted IS NOT TRUE
    `;

    const queryValues = [];

    // Superadmin: all incidents.
    if (role_id === ROLE_SUPERADMIN) {
      // No additional filter required.
    } else if (role_id === ROLE_ADMIN) {
      // Admin: incidents belonging to their company.
      queryValues.push(company_id);
      queryText += ` AND ir.company_id = $${queryValues.length}`;
    } else {
      // Subadmin and crew: incidents belonging to their company and ship.
      queryValues.push(company_id, ship_id);
      queryText += `
        AND ir.company_id = $${queryValues.length - 1}
        AND ir.ship_id = $${queryValues.length}
      `;
    }

    queryText += `
      ORDER BY ir.occurred_at DESC NULLS LAST,
               ir.created_at DESC
    `;

    const { rows } = await db.query(queryText, queryValues);

    return res.status(200).json(rows);
  } catch (error) {
    console.error("Error getting incidents:", error);

    return res.status(500).json({
      error: "Failed to fetch incidents",
    });
  }
};


export const getIncidentById = async (req, res) => {
  const incidentId = req.params.id;

  if (!isUuid(incidentId)) {
    return res.status(400).json({
      error: "incident_id must be a UUID",
    });
  }

  try {
    const { rows } = await db.query(
      `
      SELECT
        ir.*,
        ird.incident_id AS details_incident_id,
        ird.vessel_name_snapshot,
        ird.asset_identifier,
        ird.flag_or_managing_company,
        ird.reporter_name_snapshot,
        ird.reporter_rank,
        ird.department,
        ird.event_utc_offset,
        ird.incident_categories,
        ird.event_chronology,
        ird.operating_conditions,
        ird.actual_impacts,
        ird.potential_impacts,
        ird.injury_classification,
        ird.operational_delay_hours,
        ird.actual_effects_description,
        ird.credible_worst_outcome,
        ird.master_notified_at,
        ird.stabilized_at,
        ird.ongoing_dangers,
        ird.emt_convened_status,
        ird.external_statements_review_status,
        ird.notifications,
        ird.evidence_items,
        ird.vdr_cctv_recording_window,
        ird.investigation_leads,
        ird.rca_method,
        ird.direct_cause,
        ird.contributing_conditions,
        ird.immediate_correction,
        ird.capa_actions,
        ird.pms_work_order_references,
        ird.purchase_requisition_references,
        ird.car_reference,
        ird.safety_meeting_at,
        ird.safety_meeting_minutes_reference,
        ird.fleet_bulletin_lms_training_reference,
        ird.master_approval,
        ird.safety_officer_approval,
        ird.vessel_manager_approval,
        ird.marine_manager_approval,
        ird.marine_standards_approval,
        ird.action_effectiveness_status,
        ird.fleet_learning_status,
        ird.closure_justification,
        ird.created_at AS details_created_at,
        ird.updated_at AS details_updated_at
      FROM incident_reports ir
      LEFT JOIN incident_report_details ird
        ON ird.incident_id = ir.incident_id
      WHERE ir.incident_id = $1
        AND ir.is_deleted IS NOT TRUE
      `,
      [incidentId]
    );

    if (rows.length === 0) {
      return res.status(404).json({
        error: "Incident not found",
      });
    }

    const row = rows[0];

    // Preserve existing role-based access control.
    if (!canAccessIncident(req.user, row)) {
      return res.status(403).json({
        error: "Forbidden",
      });
    }

    // Keep questionnaire fields grouped under `details`.
    const {
      details_incident_id,
      vessel_name_snapshot,
      asset_identifier,
      flag_or_managing_company,
      reporter_name_snapshot,
      reporter_rank,
      department,
      event_utc_offset,
      incident_categories,
      event_chronology,
      operating_conditions,
      actual_impacts,
      potential_impacts,
      injury_classification,
      operational_delay_hours,
      actual_effects_description,
      credible_worst_outcome,
      master_notified_at,
      stabilized_at,
      ongoing_dangers,
      emt_convened_status,
      external_statements_review_status,
      notifications,
      evidence_items,
      vdr_cctv_recording_window,
      investigation_leads,
      rca_method,
      direct_cause,
      contributing_conditions,
      immediate_correction,
      capa_actions,
      pms_work_order_references,
      purchase_requisition_references,
      car_reference,
      safety_meeting_at,
      safety_meeting_minutes_reference,
      fleet_bulletin_lms_training_reference,
      master_approval,
      safety_officer_approval,
      vessel_manager_approval,
      marine_manager_approval,
      marine_standards_approval,
      action_effectiveness_status,
      fleet_learning_status,
      closure_justification,
      details_created_at,
      details_updated_at,
      ...incident
    } = row;

    const details =
      details_incident_id === null || details_incident_id === undefined
        ? null
        : {
            incident_id: details_incident_id,
            vessel_name_snapshot,
            asset_identifier,
            flag_or_managing_company,
            reporter_name_snapshot,
            reporter_rank,
            department,
            event_utc_offset,
            incident_categories,
            event_chronology,
            operating_conditions,
            actual_impacts,
            potential_impacts,
            injury_classification,
            operational_delay_hours,
            actual_effects_description,
            credible_worst_outcome,
            master_notified_at,
            stabilized_at,
            ongoing_dangers,
            emt_convened_status,
            external_statements_review_status,
            notifications,
            evidence_items,
            vdr_cctv_recording_window,
            investigation_leads,
            rca_method,
            direct_cause,
            contributing_conditions,
            immediate_correction,
            capa_actions,
            pms_work_order_references,
            purchase_requisition_references,
            car_reference,
            safety_meeting_at,
            safety_meeting_minutes_reference,
            fleet_bulletin_lms_training_reference,
            master_approval,
            safety_officer_approval,
            vessel_manager_approval,
            marine_manager_approval,
            marine_standards_approval,
            action_effectiveness_status,
            fleet_learning_status,
            closure_justification,
            created_at: details_created_at,
            updated_at: details_updated_at,
          };

    return res.status(200).json({
      ...incident,
      details,
    });
  } catch (error) {
    console.error("Error getting incident:", error);

    return res.status(500).json({
      error: "Failed to fetch incident",
    });
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
    details = {},
  } = req.body;

  const shipId = parseInt(ship_id, 10);

  if (Number.isNaN(shipId)) {
    return res.status(400).json({
      error: "ship_id must be a number",
    });
  }

  if (!title?.trim()) {
    return res.status(400).json({
      error: "title is required",
    });
  }

  if (
    details === null ||
    typeof details !== "object" ||
    Array.isArray(details)
  ) {
    return res.status(400).json({
      error: "details must be an object",
    });
  }

  const {
    role_id,
    company_id: myCompanyId,
    ship_id: myShipId,
    user_id: myUserId,
  } = req.user;

  const detailColumns = [
    "vessel_name_snapshot",
    "asset_identifier",
    "flag_or_managing_company",
    "reporter_name_snapshot",
    "reporter_rank",
    "department",
    "event_utc_offset",
    "incident_categories",
    "event_chronology",
    "operating_conditions",
    "actual_impacts",
    "potential_impacts",
    "injury_classification",
    "operational_delay_hours",
    "actual_effects_description",
    "credible_worst_outcome",
    "master_notified_at",
    "stabilized_at",
    "ongoing_dangers",
    "emt_convened_status",
    "external_statements_review_status",
    "notifications",
    "evidence_items",
    "vdr_cctv_recording_window",
    "investigation_leads",
    "rca_method",
    "direct_cause",
    "contributing_conditions",
    "immediate_correction",
    "capa_actions",
    "pms_work_order_references",
    "purchase_requisition_references",
    "car_reference",
    "safety_meeting_at",
    "safety_meeting_minutes_reference",
    "fleet_bulletin_lms_training_reference",
    "master_approval",
    "safety_officer_approval",
    "vessel_manager_approval",
    "marine_manager_approval",
    "marine_standards_approval",
    "action_effectiveness_status",
    "fleet_learning_status",
    "closure_justification",
  ];

  const jsonbColumns = new Set([
    "incident_categories",
    "actual_impacts",
    "potential_impacts",
    "notifications",
    "evidence_items",
    "capa_actions",
  ]);

  // Reject unknown detail fields instead of silently discarding them.
  const unknownFields = Object.keys(details).filter(
    (key) => !detailColumns.includes(key)
  );

  if (unknownFields.length > 0) {
    return res.status(400).json({
      error: "Unknown incident detail fields",
      fields: unknownFields,
    });
  }

  // These fields are JSONB arrays and must contain arrays when provided.
  for (const key of jsonbColumns) {
    if (
      details[key] !== undefined &&
      details[key] !== null &&
      !Array.isArray(details[key])
    ) {
      return res.status(400).json({
        error: `${key} must be an array`,
      });
    }
  }

  const client = await db.connect();

  try {
    await client.query("BEGIN");

    const shipRes = await client.query(
      `SELECT ship_id, company_id
       FROM ships
       WHERE ship_id = $1`,
      [shipId]
    );

    if (!shipRes.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        error: "Ship not found",
      });
    }

    const shipCompanyId = shipRes.rows[0].company_id;

    if (
      role_id === ROLE_ADMIN &&
      String(shipCompanyId) !== String(myCompanyId)
    ) {
      await client.query("ROLLBACK");
      return res.status(403).json({
        error: "Forbidden: ship is outside your company",
      });
    }

    if (
      (role_id === ROLE_SUBADMIN || role_id === ROLE_CREW) &&
      (
        String(shipCompanyId) !== String(myCompanyId) ||
        Number(shipId) !== Number(myShipId)
      )
    ) {
      await client.query("ROLLBACK");
      return res.status(403).json({
        error: "Forbidden: ship is outside your scope",
      });
    }

    const reporterId = myUserId;

    const incidentResult = await client.query(
      `INSERT INTO incident_reports (
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
        $19, $20,
        false, NOW(), NOW()
      )
      RETURNING *`,
      [
        shipId,
        shipCompanyId,
        reporterId,
        visible_to_ship_only ?? null,
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

    const incident = incidentResult.rows[0];

    // Build the details INSERT from the explicit column whitelist.
    // Omitted columns retain their database defaults.
    const providedColumns = detailColumns.filter(
      (column) => details[column] !== undefined
    );

    const insertColumns = ["incident_id", ...providedColumns];

    const insertValues = [
      incident.incident_id,
      ...providedColumns.map((column) => {
        const value = details[column];

        if (jsonbColumns.has(column) && value !== null) {
          return JSON.stringify(value);
        }

        return value;
      }),
    ];

    const placeholders = insertColumns.map((column, index) => {
      const placeholder = `$${index + 1}`;

      return jsonbColumns.has(column)
        ? `${placeholder}::jsonb`
        : placeholder;
    });

    const detailsResult = await client.query(
      `INSERT INTO incident_report_details (
        ${insertColumns.join(", ")}
      )
      VALUES (${placeholders.join(", ")})
      RETURNING *`,
      insertValues
    );

    await client.query("COMMIT");

    return res.status(201).json({
      message: "Incident created successfully",
      incident: {
        ...incident,
        details: detailsResult.rows[0],
      },
    });
  } catch (error) {
    await client.query("ROLLBACK");

    console.error("Error creating incident:", error);

    return res.status(500).json({
      error: "Failed to create incident",
    });
  } finally {
    client.release();
  }
};


export const updateIncident = async (req, res) => {
  const incidentId = req.params.id;

  if (!isUuid(incidentId)) {
    return res.status(400).json({
      error: "incident_id must be a UUID",
    });
  }

  const {
    ship_id,
    company_id,
    reported_by_user_id,
    details,
    ...body
  } = req.body;

  // These fields cannot be changed through this endpoint.
  if (
    ship_id !== undefined ||
    company_id !== undefined ||
    reported_by_user_id !== undefined
  ) {
    return res.status(400).json({
      error:
        "ship_id, company_id and reported_by_user_id cannot be changed",
    });
  }

  if (
    details !== undefined &&
    (details === null ||
      typeof details !== "object" ||
      Array.isArray(details))
  ) {
    return res.status(400).json({
      error: "details must be an object",
    });
  }

  const mainFields = [
    "visible_to_ship_only",
    "title",
    "description",
    "incident_type",
    "severity",
    "priority",
    "location_on_ship",
    "immediate_action",
    "root_cause",
    "lesson_learned",
    "corrective_action",
    "preventive_action",
    "status",
    "occurred_at",
    "reported_at",
    "closed_at",
    "reference_code",
  ];

  const detailFields = [
    "vessel_name_snapshot",
    "asset_identifier",
    "flag_or_managing_company",
    "reporter_name_snapshot",
    "reporter_rank",
    "department",
    "event_utc_offset",
    "incident_categories",
    "event_chronology",
    "operating_conditions",
    "actual_impacts",
    "potential_impacts",
    "injury_classification",
    "operational_delay_hours",
    "actual_effects_description",
    "credible_worst_outcome",
    "master_notified_at",
    "stabilized_at",
    "ongoing_dangers",
    "emt_convened_status",
    "external_statements_review_status",
    "notifications",
    "evidence_items",
    "vdr_cctv_recording_window",
    "investigation_leads",
    "rca_method",
    "direct_cause",
    "contributing_conditions",
    "immediate_correction",
    "capa_actions",
    "pms_work_order_references",
    "purchase_requisition_references",
    "car_reference",
    "safety_meeting_at",
    "safety_meeting_minutes_reference",
    "fleet_bulletin_lms_training_reference",
    "master_approval",
    "safety_officer_approval",
    "vessel_manager_approval",
    "marine_manager_approval",
    "marine_standards_approval",
    "action_effectiveness_status",
    "fleet_learning_status",
    "closure_justification",
  ];

  const jsonbFields = new Set([
    "incident_categories",
    "actual_impacts",
    "potential_impacts",
    "notifications",
    "evidence_items",
    "capa_actions",
  ]);

  // Validate main-table fields.
  const unknownMainFields = Object.keys(body).filter(
    (key) => !mainFields.includes(key)
  );

  if (unknownMainFields.length > 0) {
    return res.status(400).json({
      error: "Unknown incident fields",
      fields: unknownMainFields,
    });
  }

  if (
    body.title !== undefined &&
    (typeof body.title !== "string" || !body.title.trim())
  ) {
    return res.status(400).json({
      error: "title must be a non-empty string",
    });
  }

  // Validate questionnaire fields.
  if (details !== undefined) {
    const unknownDetailFields = Object.keys(details).filter(
      (key) => !detailFields.includes(key)
    );

    if (unknownDetailFields.length > 0) {
      return res.status(400).json({
        error: "Unknown incident detail fields",
        fields: unknownDetailFields,
      });
    }

    for (const field of jsonbFields) {
      if (
        details[field] !== undefined &&
        !Array.isArray(details[field])
      ) {
        return res.status(400).json({
          error: `${field} must be an array`,
        });
      }
    }
  }

  const client = await db.connect();
  let transactionStarted = false;

  try {
    await client.query("BEGIN");
    transactionStarted = true;

    // Lock the incident while checking permissions and updating it.
    const currentResult = await client.query(
      `
      SELECT *
      FROM incident_reports
      WHERE incident_id = $1
        AND is_deleted IS NOT TRUE
      FOR UPDATE
      `,
      [incidentId]
    );

    if (currentResult.rows.length === 0) {
      await client.query("ROLLBACK");
      transactionStarted = false;

      return res.status(404).json({
        error: "Incident not found",
      });
    }

    const currentIncident = currentResult.rows[0];

    // Enforce the existing role-based authorization rules.
    if (!canModifyIncident(req.user, currentIncident)) {
      await client.query("ROLLBACK");
      transactionStarted = false;

      return res.status(403).json({
        error: "Forbidden",
      });
    }

    // Update only the main-table fields provided by the client.
    const fieldsToUpdate = mainFields.filter(
      (field) => body[field] !== undefined
    );

    let incident = currentIncident;

    if (fieldsToUpdate.length > 0) {
      const values = fieldsToUpdate.map((field) =>
        field === "title" ? body[field].trim() : body[field]
      );

      const assignments = fieldsToUpdate.map(
        (field, index) => `${field} = $${index + 1}`
      );

      values.push(incidentId);

      const updateResult = await client.query(
        `
        UPDATE incident_reports
        SET ${assignments.join(", ")},
            updated_at = NOW()
        WHERE incident_id = $${values.length}
          AND is_deleted IS NOT TRUE
        RETURNING *
        `,
        values
      );

      incident = updateResult.rows[0];
    }

    // Update questionnaire details only when details were supplied.
    if (details !== undefined) {
      const fieldsToUpdateDetails = detailFields.filter(
        (field) => details[field] !== undefined
      );

      if (fieldsToUpdateDetails.length > 0) {
        const columns = ["incident_id", ...fieldsToUpdateDetails];

        const values = [
          incidentId,
          ...fieldsToUpdateDetails.map((field) =>
            jsonbFields.has(field)
              ? JSON.stringify(details[field])
              : details[field]
          ),
        ];

        const placeholders = columns.map((column, index) => {
          const placeholder = `$${index + 1}`;

          return jsonbFields.has(column)
            ? `${placeholder}::jsonb`
            : placeholder;
        });

        const assignments = fieldsToUpdateDetails.map(
          (field, index) =>
            `${field} = $${index + 2}${
              jsonbFields.has(field) ? "::jsonb" : ""
            }`
        );

        // Create a details row if one does not exist yet.
        // Otherwise, update only the supplied questionnaire fields.
        await client.query(
          `
          INSERT INTO incident_report_details (${columns.join(", ")})
          VALUES (${placeholders.join(", ")})
          ON CONFLICT (incident_id)
          DO UPDATE SET
            ${assignments.join(", ")},
            updated_at = NOW()
          `,
          values
        );
      }
    }

    const detailsResult = await client.query(
      `
      SELECT *
      FROM incident_report_details
      WHERE incident_id = $1
      `,
      [incidentId]
    );

    await client.query("COMMIT");
    transactionStarted = false;

    return res.status(200).json({
      message: "Incident updated successfully",
      incident: {
        ...incident,
        details: detailsResult.rows[0] ?? null,
      },
    });
  } catch (error) {
    if (transactionStarted) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        console.error("Incident update rollback failed:", rollbackError);
      }
    }

    console.error("Error updating incident:", error);

    return res.status(500).json({
      error: "Failed to update incident",
    });
  } finally {
    client.release();
  }
};


export const deleteIncident = async (req, res) => {
  const incidentId = req.params.id;

  // Only Superadmins can delete incidents.
  if (Number(req.user?.role_id) !== ROLE_SUPERADMIN) {
    return res.status(403).json({
      error: "Forbidden: Only Superadmins can delete incidents.",
    });
  }

  if (!isUuid(incidentId)) {
    return res.status(400).json({
      error: "incident_id must be a UUID",
    });
  }

  try {
    const { rows } = await db.query(
      `
      UPDATE incident_reports
      SET is_deleted = TRUE,
          updated_at = NOW()
      WHERE incident_id = $1
        AND is_deleted IS NOT TRUE
      RETURNING incident_id
      `,
      [incidentId]
    );

    if (rows.length === 0) {
      return res.status(404).json({
        error: "Incident not found",
      });
    }

    return res.status(200).json({
      message: "Incident deleted successfully",
      incident_id: rows[0].incident_id,
    });
  } catch (error) {
    console.error("Error deleting incident:", error);

    return res.status(500).json({
      error: "Failed to delete incident",
    });
  }
};


//new incident training

export const getRequestedTrainings = async (req, res) => {
  const { company_id, ship_id } = req.user;
  const roleId = Number(req.user?.role_id);

  try {
    let queryText = `
      SELECT
        incident_id,
        title,
        severity,
        reference_code,
        training_request_type,
        training_requested_at
      FROM incident_reports
      WHERE is_deleted IS NOT TRUE
        AND training_requested = TRUE
    `;

    const queryValues = [];

    if (roleId === ROLE_SUPERADMIN) {
      // Superadmin can view all training requests.
    } else if (roleId === ROLE_ADMIN) {
      queryValues.push(company_id);
      queryText += ` AND company_id = $${queryValues.length}`;
    } else if (
      roleId === ROLE_SUBADMIN ||
      roleId === ROLE_CREW
    ) {
      queryValues.push(company_id, ship_id);
      queryText += `
        AND company_id = $${queryValues.length - 1}
        AND ship_id = $${queryValues.length}
      `;
    } else {
      return res.status(403).json({ error: "Forbidden" });
    }

    queryText += `
      ORDER BY training_requested_at DESC NULLS LAST
    `;

    const { rows } = await db.query(queryText, queryValues);
    return res.status(200).json(rows);
  } catch (error) {
    console.error("Error fetching requested trainings:", error);
    return res.status(500).json({
      error: "Failed to fetch requested trainings",
    });
  }
};



export const getRecentTrainingRequestCount = async (req, res) => {
  const { company_id, ship_id } = req.user;
  const roleId = Number(req.user?.role_id);

  try {
    let queryText = `
      SELECT COUNT(*)::int AS count
      FROM incident_reports
      WHERE is_deleted IS NOT TRUE
        AND training_requested = TRUE
        AND training_requested_at >= NOW() - INTERVAL '7 days'
    `;

    const queryValues = [];

    if (roleId === ROLE_SUPERADMIN) {
      // Superadmin can count all training requests.
    } else if (roleId === ROLE_ADMIN) {
      queryValues.push(company_id);
      queryText += ` AND company_id = $${queryValues.length}`;
    } else if (
      roleId === ROLE_SUBADMIN ||
      roleId === ROLE_CREW
    ) {
      queryValues.push(company_id, ship_id);
      queryText += `
        AND company_id = $${queryValues.length - 1}
        AND ship_id = $${queryValues.length}
      `;
    } else {
      return res.status(403).json({ error: "Forbidden" });
    }

    const { rows } = await db.query(queryText, queryValues);

    return res.status(200).json({
      count: rows[0].count,
    });
  } catch (error) {
    console.error("Error fetching recent training request count:", error);
    return res.status(500).json({
      error: "Failed to fetch count",
    });
  }
};




export const requestIncidentTraining = async (req, res) => {
  const incidentId = req.params.id;
  const { training_type } = req.body;
  const roleId = Number(req.user?.role_id);

  if (!isUuid(incidentId)) {
    return res.status(400).json({
      error: "incident_id must be a UUID",
    });
  }

  if (
    training_type !== undefined &&
    training_type !== null &&
    (
      !Array.isArray(training_type) ||
      !training_type.every(
        (item) => typeof item === "string" && item.trim().length > 0
      )
    )
  ) {
    return res.status(400).json({
      error: "training_type must be an array of non-empty strings",
    });
  }

  if (
    ![
      ROLE_SUPERADMIN,
      ROLE_ADMIN,
      ROLE_SUBADMIN,
      ROLE_CREW,
    ].includes(roleId)
  ) {
    return res.status(403).json({ error: "Forbidden" });
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

    if (currentRes.rows.length === 0) {
      return res.status(404).json({
        error: "Incident not found",
      });
    }

    const user = {
      ...req.user,
      role_id: roleId,
    };

    if (!canAccessIncident(user, currentRes.rows[0])) {
      return res.status(403).json({
        error: "Forbidden: You do not have access to this incident",
      });
    }

    const { rows } = await db.query(
      `
        UPDATE incident_reports
        SET
          training_requested = TRUE,
          training_request_type = COALESCE($1, training_request_type),
          training_requested_at = NOW(),
          updated_at = NOW()
        WHERE incident_id = $2
          AND is_deleted IS NOT TRUE
        RETURNING *
      `,
      [training_type ?? null, incidentId]
    );

    if (rows.length === 0) {
      return res.status(404).json({
        error: "Incident not found",
      });
    }

    return res.status(200).json({
      message: "Training requested successfully",
      incident: rows[0],
    });
  } catch (error) {
    console.error("Error requesting training:", error);
    return res.status(500).json({
      error: "Failed to request training",
    });
  }
};


//ai
export const generateDashboard = async(req,res)=>{

  const roleId = req.user?.role_id;
  if(roleId !== 1 && roleId!== 2)
  {
    return res.status(403).json({
      error: 'Access denied. Only Admins and Superadmins can regenerate AI analytics.' 
    })
  }
  const {incident_id}= req.params;

  try {
    // Fetch ALL mandatory fields from the form/database
    const fetchQuery = `
      SELECT 
        title, 
        incident_type, 
        severity, 
        priority, 
        location_on_ship, 
        ship_id, 
        occurred_at, 
        description 
      FROM incident_reports 
      WHERE incident_id = $1
    `;

    const fetchResult = await db.query(fetchQuery, [incident_id]);

    if(fetchResult.rows.length === 0)
    {
      return res.status(404).json({error: 'Incident not found'})
    }

    const incidentData = fetchResult.rows[0];

    //validation to check description is not empty
    if (!incidentData.description || incidentData.description.trim() === '') {
      return res.status(400).json({ error: "Description is required to generate analysis" });
    }

    //passing object to gemini api
    const aiDashboardData = await generateIncidentDashboard(incidentData);

    //save the ai content in the JSONB column
    const updateQuery = `
      UPDATE incident_reports
      SET
        ai_dashboard_data = $1,
        updated_at = CURRENT_TIMESTAMP
      WHERE incident_id = $2
      RETURNING ai_dashboard_data, updated_at;
    `;

    const updateResult = await db.query(updateQuery, [aiDashboardData,incident_id]);

    return res.status(200).json({
      message: 'Dashboard regenerated successfully',
      data: updateResult.rows[0].ai_dashboard_data,
      last_updated: updateResult.rows[0].updated_at
    });
  } catch (error) {
    console.error('Error generating AI dashboard:', error);
    return res.status(500).json({ error: 'Failed to process AI dashboard generation.' });
  
  }
}
