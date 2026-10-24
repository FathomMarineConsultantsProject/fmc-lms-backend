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
  const roleId = Number(user.role_id);
  const companyId = user.company_id;

  // Superadmin can see every non-deleted incident.
  if (roleId === ROLE_SUPERADMIN) {
    return {
      text: `
        SELECT ir.*
        FROM incident_reports ir
        WHERE ir.is_deleted IS NOT TRUE
        ORDER BY ir.occurred_at DESC NULLS LAST, ir.created_at DESC
      `,
      values: [],
    };
  }

  // Other users see their company's incidents and
  // incidents created by a Superadmin.
  return {
    text: `
      SELECT ir.*
      FROM incident_reports ir
      WHERE ir.is_deleted IS NOT TRUE
        AND (
          ir.company_id = $1
          OR EXISTS (
            SELECT 1
            FROM users u
            WHERE u.user_id = ir.reported_by_user_id
              AND u.role_id = $2
          )
        )
      ORDER BY ir.occurred_at DESC NULLS LAST, ir.created_at DESC
    `,
    values: [companyId, ROLE_SUPERADMIN],
  };
};



const canAccessIncident = (user, incident) => {
  const roleId = Number(user?.role_id);

  if (roleId === ROLE_SUPERADMIN) {
    return true;
  }

  const belongsToCompany =
    user?.company_id != null &&
    incident?.company_id != null &&
    String(incident.company_id) === String(user.company_id);

  const createdBySuperadmin =
    incident?.created_by_superadmin === true;

  return belongsToCompany || createdBySuperadmin;
};


const canModifyIncident = (user, incident) => {
  const roleId = Number(user?.role_id);

  // Superadmin can edit every incident.
  if (roleId === ROLE_SUPERADMIN) {
    return true;
  }

  // Incidents created by Superadmin are restricted to Superadmin.
  if (incident?.created_by_superadmin === true) {
    return false;
  }

  // Only an Admin from the same company can edit
  // incidents created by company users.
  return (
    roleId === ROLE_ADMIN &&
    user?.company_id != null &&
    incident?.company_id != null &&
    String(user.company_id) === String(incident.company_id)
  );
};





export const getAllIncidents = async (req, res) => {
  try {
    const roleId = Number(req.user?.role_id);
    const companyId = req.user?.company_id;

    if (
      ![
        ROLE_SUPERADMIN,
        ROLE_ADMIN,
        ROLE_SUBADMIN,
        ROLE_CREW,
      ].includes(roleId)
    ) {
      return res.status(403).json({
        error: "Forbidden",
      });
    }

    let queryText = `
      SELECT
        ir.*,
        EXISTS (
          SELECT 1
          FROM users u
          WHERE u.user_id = ir.reported_by_user_id
            AND u.role_id = $1
        ) AS created_by_superadmin,
        CASE
          WHEN ird.incident_id IS NULL THEN NULL
          ELSE to_jsonb(ird)
        END AS details
      FROM incident_reports ir
      LEFT JOIN incident_report_details ird
        ON ird.incident_id = ir.incident_id
      WHERE ir.is_deleted IS NOT TRUE
    `;

    let queryValues = [ROLE_SUPERADMIN];

    // Superadmin sees all non-deleted incidents.
    // Other users see their company's incidents and
    // incidents created by a Superadmin.
    if (roleId !== ROLE_SUPERADMIN) {
      queryValues.push(companyId);

      queryText += `
        AND (
          ir.company_id = $2
          OR EXISTS (
            SELECT 1
            FROM users u
            WHERE u.user_id = ir.reported_by_user_id
              AND u.role_id = $1
          )
        )
      `;
    }

    queryText += `
      ORDER BY
        ir.occurred_at DESC NULLS LAST,
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
        EXISTS (
          SELECT 1
          FROM users u
          WHERE u.user_id = ir.reported_by_user_id
            AND u.role_id = $2
        ) AS created_by_superadmin,

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
      [incidentId, ROLE_SUPERADMIN]
    );

    if (rows.length === 0) {
      return res.status(404).json({
        error: "Incident not found",
      });
    }

    const row = rows[0];

    // Option A: Superadmin sees all incidents.
    // Other users see their company's incidents or
    // incidents created by a Superadmin.
    if (!canAccessIncident(req.user, row)) {
      return res.status(403).json({
        error: "Forbidden",
      });
    }

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
      created_by_superadmin,
      ...incident
    } = row;

    const details =
      details_incident_id == null
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
  } = req.body ?? {};

  // Identity and assignments come from the authenticated JWT.
  const {
    user_id: myUserId,
    role_id,
    company_id: myCompanyId,
    ship_id: myShipId,
  } = req.user ?? {};

  const roleId = Number(role_id);
  const isSuperAdmin = roleId === ROLE_SUPERADMIN;

  if (
    ![ROLE_SUPERADMIN, ROLE_ADMIN, ROLE_SUBADMIN, ROLE_CREW].includes(
      roleId
    ) ||
    myUserId == null
  ) {
    return res.status(401).json({
      error: "Invalid authenticated user",
    });
  }

  if (typeof title !== "string" || !title.trim()) {
    return res.status(400).json({
      error: "title is required",
    });
  }

  if (typeof description !== "string" || !description.trim()) {
    return res.status(400).json({
      error: "description is required",
    });
  }

  if (!occurred_at || Number.isNaN(Date.parse(occurred_at))) {
    return res.status(400).json({
      error: "occurred_at must be a valid date and time",
    });
  }

  if (
    !details ||
    typeof details !== "object" ||
    Array.isArray(details)
  ) {
    return res.status(400).json({
      error: "details must be an object",
    });
  }

  // Normal users must have a company; Superadmin does not need one.
  if (!isSuperAdmin && myCompanyId == null) {
    return res.status(400).json({
      error: "Your account must be associated with a company.",
    });
  }

  // Never accept ship_id or company_id from the request body.
  const shipId = isSuperAdmin
    ? null
    : myShipId == null || myShipId === ""
      ? null
      : Number(myShipId);

  const incidentCompanyId = isSuperAdmin ? null : myCompanyId;

  if (
    shipId !== null &&
    (!Number.isInteger(shipId) || shipId <= 0)
  ) {
    return res.status(400).json({
      error: "Invalid ship assignment in authenticated user.",
    });
  }

  // Validate visibility if supplied.
  if (
    visible_to_ship_only !== undefined &&
    typeof visible_to_ship_only !== "boolean"
  ) {
    return res.status(400).json({
      error: "visible_to_ship_only must be a boolean",
    });
  }

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

  const unknownFields = Object.keys(details).filter(
    (key) => !detailColumns.includes(key)
  );

  if (unknownFields.length > 0) {
    return res.status(400).json({
      error: "Unknown incident detail fields",
      fields: unknownFields,
    });
  }

  for (const key of jsonbColumns) {
    if (details[key] != null && !Array.isArray(details[key])) {
      return res.status(400).json({
        error: `${key} must be an array or null`,
      });
    }
  }

  if (
    details.vessel_name_snapshot != null &&
    typeof details.vessel_name_snapshot !== "string"
  ) {
    return res.status(400).json({
      error: "vessel_name_snapshot must be a string",
    });
  }

  const client = await db.connect();
  let transactionStarted = false;

  try {
    await client.query("BEGIN");
    transactionStarted = true;

    // Validate the ship assignment from the JWT, when present.
    if (shipId !== null) {
      const shipResult = await client.query(
        `SELECT ship_id, company_id
         FROM ships
         WHERE ship_id = $1`,
        [shipId]
      );

      if (shipResult.rowCount === 0) {
        await client.query("ROLLBACK");
        transactionStarted = false;

        return res.status(400).json({
          error: "The ship assigned to your account was not found.",
        });
      }

      const assignedShip = shipResult.rows[0];

      if (
        String(assignedShip.company_id) !==
        String(incidentCompanyId)
      ) {
        await client.query("ROLLBACK");
        transactionStarted = false;

        return res.status(403).json({
          error: "Your assigned ship does not belong to your company.",
        });
      }
    }

    // Insert the incident.
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
        reference_code
      )
      VALUES (
        $1,
        $2,
        $3,
        COALESCE($4::boolean, $5::boolean),
        $6,
        $7,
        $8,
        $9,
        $10,
        $11,
        $12,
        $13,
        $14,
        $15,
        $16,
        COALESCE($17, 'Reported'),
        $18,
        COALESCE($19, NOW()),
        $20,
        $21
      )
      RETURNING *`,
      [
        shipId,                         // $1
        incidentCompanyId,              // $2
        myUserId,                       // $3
        visible_to_ship_only ?? null,   // $4
        shipId !== null,                // $5
        title.trim(),                   // $6
        description.trim(),             // $7
        incident_type || null,          // $8
        severity || null,               // $9
        priority || null,               // $10
        location_on_ship || null,       // $11
        immediate_action || null,       // $12
        root_cause || null,             // $13
        lesson_learned || null,         // $14
        corrective_action || null,      // $15
        preventive_action || null,      // $16
        status || null,                 // $17
        occurred_at,                    // $18
        reported_at || null,            // $19
        closed_at || null,              // $20
        reference_code || null,          // $21
      ]
    );

    const incident = incidentResult.rows[0];

    // Insert optional incident details.
    const providedColumns = detailColumns.filter(
      (column) => details[column] !== undefined
    );

    let savedDetails = null;

    if (providedColumns.length > 0) {
      const insertColumns = ["incident_id", ...providedColumns];

      const insertValues = [
        incident.incident_id,
        ...providedColumns.map((column) => {
          const value = details[column];

          return jsonbColumns.has(column) && value !== null
            ? JSON.stringify(value)
            : value;
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

      savedDetails = detailsResult.rows[0];
    }

    await client.query("COMMIT");
    transactionStarted = false;

    return res.status(201).json({
      message: "Incident created successfully",
      incident: {
        ...incident,
        details: savedDetails,
      },
    });
  } catch (error) {
    if (transactionStarted) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        console.error("Incident creation rollback failed:", rollbackError);
      }
    }

    // Log the actual error for diagnosis in server logs.
    console.error("Error creating incident:", {
      message: error.message,
      code: error.code,
      detail: error.detail,
      constraint: error.constraint,
      table: error.table,
      column: error.column,
    });

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

  const client = await db.connect();
  let transactionStarted = false;

  try {
    await client.query("BEGIN");
    transactionStarted = true;

    // Fetch and lock the incident, including its creator's role.
    const { rows } = await client.query(
      `
        SELECT
          ir.*,
          EXISTS (
            SELECT 1
            FROM users u
            WHERE u.user_id = ir.reported_by_user_id
              AND u.role_id = $2
          ) AS created_by_superadmin
        FROM incident_reports ir
        WHERE ir.incident_id = $1
          AND ir.is_deleted IS NOT TRUE
        FOR UPDATE OF ir
      `,
      [incidentId, ROLE_SUPERADMIN]
    );

    if (rows.length === 0) {
      await client.query("ROLLBACK");
      transactionStarted = false;

      return res.status(404).json({
        error: "Incident not found",
      });
    }

    const currentIncident = rows[0];

    // Superadmin can edit all incidents.
    // Only same-company Admins can edit company-user-created incidents.
    if (!canModifyIncident(req.user, currentIncident)) {
      await client.query("ROLLBACK");
      transactionStarted = false;

      return res.status(403).json({
        error: "You are not authorized to update this incident.",
      });
    }

    const body = req.body ?? {};

    const hasField = (field) =>
      Object.prototype.hasOwnProperty.call(body, field);

    // Validate main incident fields.
    const incidentColumns = [
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

    const incidentUpdates = incidentColumns.filter(hasField);

    if (
      hasField("title") &&
      (typeof body.title !== "string" || !body.title.trim())
    ) {
      await client.query("ROLLBACK");
      transactionStarted = false;

      return res.status(400).json({
        error: "title must be a non-empty string",
      });
    }

    if (
      hasField("description") &&
      (typeof body.description !== "string" ||
        !body.description.trim())
    ) {
      await client.query("ROLLBACK");
      transactionStarted = false;

      return res.status(400).json({
        error: "description must be a non-empty string",
      });
    }

    if (
      hasField("occurred_at") &&
      (!body.occurred_at ||
        Number.isNaN(Date.parse(body.occurred_at)))
    ) {
      await client.query("ROLLBACK");
      transactionStarted = false;

      return res.status(400).json({
        error: "occurred_at must be a valid date and time",
      });
    }

    // Validate ship_id only when supplied.
    let shipId = currentIncident.ship_id;
    let companyId = currentIncident.company_id;

    const roleId = Number(req.user?.role_id);

    if (hasField("ship_id")) {
      const suppliedShipId = body.ship_id;

      if (
        suppliedShipId !== null &&
        suppliedShipId !== "" &&
        (!Number.isInteger(Number(suppliedShipId)) ||
          Number(suppliedShipId) <= 0)
      ) {
        await client.query("ROLLBACK");
        transactionStarted = false;

        return res.status(400).json({
          error: "ship_id must be a positive integer or null",
        });
      }

      shipId =
        suppliedShipId === null || suppliedShipId === ""
          ? null
          : Number(suppliedShipId);

      if (shipId !== null) {
        const { rows: shipRows } = await client.query(
          `
            SELECT ship_id, company_id
            FROM ships
            WHERE ship_id = $1
          `,
          [shipId]
        );

        if (shipRows.length === 0) {
          await client.query("ROLLBACK");
          transactionStarted = false;

          return res.status(400).json({
            error: "Invalid ship_id. Ship not found.",
          });
        }

        const ship = shipRows[0];

        // Company users cannot select another company's ship.
        if (
          roleId !== ROLE_SUPERADMIN &&
          String(ship.company_id) !== String(req.user?.company_id)
        ) {
          await client.query("ROLLBACK");
          transactionStarted = false;

          return res.status(403).json({
            error: "You cannot assign a ship from another company.",
          });
        }

        // Subadmins and Crew must use their assigned ship.
        if (
          [ROLE_SUBADMIN, ROLE_CREW].includes(roleId) &&
          Number(ship.ship_id) !== Number(req.user?.ship_id)
        ) {
          await client.query("ROLLBACK");
          transactionStarted = false;

          return res.status(403).json({
            error: "Forbidden: ship is outside your scope",
          });
        }

        companyId = ship.company_id;
      }
    }

    // Company users cannot move incidents outside their company.
    if (
      roleId !== ROLE_SUPERADMIN &&
      String(companyId) !== String(req.user?.company_id)
    ) {
      await client.query("ROLLBACK");
      transactionStarted = false;

      return res.status(403).json({
        error: "You cannot update an incident belonging to another company.",
      });
    }

    // Update the main incident table.
    const mainValues = [incidentId];
    const mainSetClauses = [];

    for (const column of incidentUpdates) {
      let value = body[column];

      if (column === "title" || column === "description") {
        value = value.trim();
      }

      mainValues.push(value);
      mainSetClauses.push(
        `${column} = $${mainValues.length}`
      );
    }

    // Ship and company are updated together when ship_id is supplied.
    if (hasField("ship_id")) {
      mainValues.push(shipId);
      mainSetClauses.push(`ship_id = $${mainValues.length}`);

      mainValues.push(companyId);
      mainSetClauses.push(`company_id = $${mainValues.length}`);
    }

    if (mainSetClauses.length > 0) {
      mainSetClauses.push("updated_at = NOW()");

      await client.query(
        `
          UPDATE incident_reports
          SET ${mainSetClauses.join(", ")}
          WHERE incident_id = $1
            AND is_deleted IS NOT TRUE
        `,
        mainValues
      );
    }

    // Whitelist of supported incident detail columns.
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

    if (hasField("details")) {
      const { details } = body;

      if (
        details === null ||
        typeof details !== "object" ||
        Array.isArray(details)
      ) {
        await client.query("ROLLBACK");
        transactionStarted = false;

        return res.status(400).json({
          error: "details must be an object",
        });
      }

      const invalidKeys = Object.keys(details).filter(
        (key) => !detailColumns.includes(key)
      );

      if (invalidKeys.length > 0) {
        await client.query("ROLLBACK");
        transactionStarted = false;

        return res.status(400).json({
          error: "Invalid incident detail fields",
          invalid_fields: invalidKeys,
        });
      }

      for (const key of jsonbColumns) {
        if (
          details[key] !== undefined &&
          details[key] !== null &&
          !Array.isArray(details[key])
        ) {
          await client.query("ROLLBACK");
          transactionStarted = false;

          return res.status(400).json({
            error: `${key} must be an array or null`,
          });
        }
      }

      if (
        details.vessel_name_snapshot !== undefined &&
        details.vessel_name_snapshot !== null &&
        typeof details.vessel_name_snapshot !== "string"
      ) {
        await client.query("ROLLBACK");
        transactionStarted = false;

        return res.status(400).json({
          error: "vessel_name_snapshot must be a string or null",
        });
      }

      const providedColumns = Object.keys(details);

      if (providedColumns.length > 0) {
        const detailValues = [incidentId];

        const detailSetClauses = providedColumns.map((column) => {
          let value = details[column];

          if (jsonbColumns.has(column)) {
            value = value === null ? null : JSON.stringify(value);
          }

          detailValues.push(value);

          const placeholder = `$${detailValues.length}`;

          return jsonbColumns.has(column)
            ? `${column} = ${placeholder}::jsonb`
            : `${column} = ${placeholder}`;
        });

        detailSetClauses.push("updated_at = NOW()");

        const { rowCount } = await client.query(
          `
            UPDATE incident_report_details
            SET ${detailSetClauses.join(", ")}
            WHERE incident_id = $1
          `,
          detailValues
        );

        if (rowCount === 0) {
          await client.query("ROLLBACK");
          transactionStarted = false;

          return res.status(404).json({
            error: "Incident details not found",
          });
        }
      }
    }

    await client.query("COMMIT");
    transactionStarted = false;

    // Return the updated incident with nested details.
    const { rows: responseRows } = await db.query(
      `
        SELECT
          ir.*,
          CASE
            WHEN d.incident_id IS NULL THEN NULL
            ELSE to_jsonb(d)
          END AS details
        FROM incident_reports ir
        LEFT JOIN incident_report_details d
          ON d.incident_id = ir.incident_id
        WHERE ir.incident_id = $1
          AND ir.is_deleted IS NOT TRUE
      `,
      [incidentId]
    );

    if (responseRows.length === 0) {
      return res.status(404).json({
        error: "Incident not found after update",
      });
    }

    const incident = responseRows[0];
    delete incident.created_by_superadmin;

    return res.status(200).json({
      message: "Incident updated successfully",
      incident,
    });
  } catch (error) {
    if (transactionStarted) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        console.error(
          "Incident update rollback failed:",
          rollbackError
        );
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
  if (Number(req.user?.role_id) !== ROLE_SUPERADMIN) {
    return res.status(403).json({
      error: "Only Superadmin can delete incidents.",
    });
  }

  const incidentId = req.params.id;

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
  const { training_type } = req.body ?? {};
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
        (item) =>
          typeof item === "string" && item.trim().length > 0
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
    return res.status(403).json({
      error: "Forbidden",
    });
  }

  try {
    const { rows: incidentRows } = await db.query(
      `
        SELECT
          ir.*,
          EXISTS (
            SELECT 1
            FROM users u
            WHERE u.user_id = ir.reported_by_user_id
              AND u.role_id = $2
          ) AS created_by_superadmin
        FROM incident_reports ir
        WHERE ir.incident_id = $1
          AND ir.is_deleted IS NOT TRUE
      `,
      [incidentId, ROLE_SUPERADMIN]
    );

    if (incidentRows.length === 0) {
      return res.status(404).json({
        error: "Incident not found",
      });
    }

    const incident = incidentRows[0];

    if (!canAccessIncident(req.user, incident)) {
      return res.status(403).json({
        error: "Forbidden: You do not have access to this incident",
      });
    }

    const { rows } = await db.query(
      `
        UPDATE incident_reports
        SET
          training_requested = TRUE,
          training_request_type =
            COALESCE($1::text[], training_request_type),
          training_requested_at = NOW(),
          updated_at = NOW()
        WHERE incident_id = $2
          AND is_deleted IS NOT TRUE
        RETURNING *
      `,
      [
        training_type == null
          ? null
          : training_type.map((item) => item.trim()),
        incidentId,
      ]
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
export const generateDashboard = async (req, res) => {

  const roleId = req.user?.role_id;
  if (roleId !== 1 && roleId !== 2) {
    return res.status(403).json({
      error: 'Access denied. Only Admins and Superadmins can regenerate AI analytics.'
    })
  }
  const { incident_id } = req.params;

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

    if (fetchResult.rows.length === 0) {
      return res.status(404).json({ error: 'Incident not found' })
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

    const updateResult = await db.query(updateQuery, [aiDashboardData, incident_id]);

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
