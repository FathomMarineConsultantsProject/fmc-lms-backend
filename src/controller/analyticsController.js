
import { db } from "../db.js";



const ROLE_SUPERADMIN = 1;
const ROLE_ADMIN = 2;

const EXPIRING_SOON_DAYS = 14;

const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ============================================================
// SHARED HELPER FUNCTIONS
// ============================================================

// ============================================================
// FMI 360 - COMBINED ANALYTICS
// ============================================================
// Add to src/controller/analyticsController.js
//
// Import db only if not already imported:
// import { db } from "../db.js";
//
// Roles:
// 1 = Super Admin
// 2 = Company Admin
// Only roles 1 and 2 may access analytics.
//
// All endpoints are unpaginated.
// ============================================================

const FMI_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function fmiError(status, message) {
  return Object.assign(new Error(message), { status });
}

function fmiPositiveId(raw, name) {
  if (raw === undefined || raw === null || raw === "") {
    return null;
  }

  if (!/^[1-9]\d*$/.test(String(raw))) {
    throw fmiError(400, `Invalid ${name}`);
  }

  const result = Number(raw);

  if (!Number.isSafeInteger(result)) {
    throw fmiError(400, `Invalid ${name}`);
  }

  return result;
}

function fmiDate(raw, name) {
  if (raw === undefined || raw === null || raw === "") {
    return null;
  }

  if (
    typeof raw !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(raw)
  ) {
    throw fmiError(400, `${name} must be YYYY-MM-DD`);
  }

  const date = new Date(`${raw}T00:00:00Z`);

  if (
    Number.isNaN(date.getTime()) ||
    date.toISOString().slice(0, 10) !== raw
  ) {
    throw fmiError(400, `Invalid ${name}`);
  }

  return raw;
}

// ============================================================
// ROLE SCOPE AND FILTERS
// ============================================================

function fmiScope(req) {
  const role = Number(req.user?.role_id);

  if (![1, 2].includes(role)) {
    throw fmiError(
      403,
      "FMI analytics require an administrative role"
    );
  }

  const q = req.query || {};

  const requestedCompany = q.companyId || null;
  const requestedShip = fmiPositiveId(q.shipId, "shipId");

  const shipType =
    q.shipType == null || q.shipType === ""
      ? null
      : String(q.shipType).trim();

  const rank =
    q.rank == null || q.rank === ""
      ? null
      : String(q.rank).trim();

  const crewStatus =
    q.crewStatus == null || q.crewStatus === ""
      ? null
      : String(q.crewStatus).trim();

  const from = fmiDate(q.dateFrom, "dateFrom");
  const to = fmiDate(q.dateTo, "dateTo");

  if (from && to && from > to) {
    throw fmiError(
      400,
      "dateFrom must not exceed dateTo"
    );
  }

  if (
    requestedCompany &&
    !FMI_UUID_RE.test(requestedCompany)
  ) {
    throw fmiError(400, "Invalid companyId");
  }

  if (shipType && shipType.length > 100) {
    throw fmiError(400, "shipType is too long");
  }

  if (rank && rank.length > 100) {
    throw fmiError(400, "rank is too long");
  }

  if (crewStatus && crewStatus.length > 50) {
    throw fmiError(400, "crewStatus is too long");
  }

  if (
    q.excludeTest != null &&
    !["true", "false"].includes(String(q.excludeTest))
  ) {
    throw fmiError(
      400,
      "excludeTest must be true or false"
    );
  }

  let companyId = requestedCompany;
  let shipId = requestedShip;

  // Company Admin
  if (role === 2) {
    if (!req.user?.company_id) {
      throw fmiError(403, "Company scope missing");
    }

    if (
      requestedCompany &&
      requestedCompany.toLowerCase() !==
        String(req.user.company_id).toLowerCase()
    ) {
      throw fmiError(
        403,
        "Another company is outside your scope"
      );
    }

    companyId = req.user.company_id;
  }

  return {
    role,

    params: [
      companyId,
      shipId,
      shipType,
      rank,
      crewStatus,
      from,
      to,
      q.excludeTest === "true",
    ],

    filters: {
      companyId,
      shipId,
      shipType,
      rank,
      crewStatus,
      dateFrom: from,
      dateTo: to,
      excludeTest: q.excludeTest === "true",
    },
  };
}

// ============================================================
// ERROR HANDLER
// ============================================================

function fmiSendError(res, error, functionName) {
  if (
    error.status >= 400 &&
    error.status < 500
  ) {
    return res.status(error.status).json({
      success: false,
      message: error.message,
    });
  }

  console.error(`${functionName}:`, error);

  return res.status(500).json({
    success: false,
    message: "Failed to load FMI 360 analytics",
  });
}

// ============================================================
// CERTIFICATE STATUS
// ============================================================


// ============================================================
// COMPETENCY MATRIX + READINESS ANALYTICS (FMI 360)
// Matrix is training-category progress; it is not independently
// verified occupational competency or regulatory compliance.
// ============================================================
const FMI_MATRIX_DOMAINS = [
  ["Navigation", "navigation"],
  ["Deck", "deck"],
  ["Engine", "engine"],
  ["Galley", "galley"],
  ["Shore", "shore"],
  ["Safety", "safety"],
  ["Environment", "environment"],
  ["Human", "human"],
  ["Cyber Security", "cyber_security"],
  ["General Induction", "general_induction"],
  ["Catering Galley", "catering_galley"],
  ["Cargo", "cargo"],
];

function fmiMatrixTotalSql(alias, suffix) {
  return FMI_MATRIX_DOMAINS.map(([, key]) =>
    `COALESCE(${alias}.${key}_total_${suffix}, 0)`
  ).join(" + ");
}

function fmiMatrixDomainValuesSql(alias = "m") {
  return FMI_MATRIX_DOMAINS.map(([title, key]) =>
    `('${title}', COALESCE(${alias}.${key}_total_assigned, 0), ` +
    `COALESCE(${alias}.${key}_total_completed, 0))`
  ).join(",\n");
}

function fmiReadinessStatus(score, hardStop) {
  if (hardStop) return "not_ready";
  if (score == null || !Number.isFinite(Number(score))) return "unassessed";
  if (Number(score) >= 80) return "ready";
  if (Number(score) >= 50) return "conditionally_ready";
  return "not_ready";
}

function fmiCertificateStatusSql(alias = "cert") {
  return `
    CASE
      WHEN COALESCE((to_jsonb(${alias})->>'is_revoked')::boolean, false)
        OR LOWER(COALESCE(${alias}.status, 'active')) = 'revoked'
        THEN 'revoked'

      WHEN LOWER(COALESCE(${alias}.status, '')) = 'failed'
        THEN 'failed'

      WHEN LOWER(COALESCE(${alias}.status, '')) = 'expired'
        THEN 'expired'

      WHEN ${alias}.expiry_date IS NOT NULL
        AND ${alias}.expiry_date < CURRENT_DATE
        THEN 'expired'

      WHEN ${alias}.expiry_date IS NOT NULL
        AND ${alias}.expiry_date <= CURRENT_DATE + 14
        THEN 'expiring_soon'

      ELSE 'active'
    END
  `;
}

// ============================================================
// COMBINED CTE
// ============================================================
//
// One row per seafarer in fmi_per_crew.
//
// Separately aggregate:
// - Course enrollments
// - Assessment attempts
// - Certificates
//
// Then combine these aggregated results with the users table.
//
// This avoids count multiplication when one user has multiple
// courses, attempts and certificates.
// ============================================================

const fmiCombinedCte = `
WITH
fmi_filter AS (
  SELECT
    $1::uuid AS company_id,
    $2::int AS ship_id,
    $3::text AS ship_type,
    $4::text AS rank,
    $5::text AS crew_status,
    $6::date AS date_from,
    $7::date AS date_to,
    $8::boolean AS exclude_test
),

fmi_companies AS (
  SELECT
    co.company_id,
    co.company_name,
    co.code,
    co.is_active,
    co.created_at

  FROM public.company co
  CROSS JOIN fmi_filter f

  WHERE
    (f.company_id IS NULL OR co.company_id = f.company_id)

    AND (
      f.ship_id IS NULL
      OR EXISTS (
        SELECT 1
        FROM public.ships sx
        WHERE sx.company_id = co.company_id
          AND sx.ship_id = f.ship_id
          AND (
            NOT f.exclude_test
            OR sx.is_test_ship = false
          )
      )
    )

    AND (
      f.ship_type IS NULL
      OR EXISTS (
        SELECT 1
        FROM public.ships sx
        WHERE sx.company_id = co.company_id
          AND sx.ship_type = f.ship_type
          AND (
            f.ship_id IS NULL
            OR sx.ship_id = f.ship_id
          )
          AND (
            NOT f.exclude_test
            OR sx.is_test_ship = false
          )
      )
    )
),

fmi_ships AS (
  SELECT
    s.ship_id,
    s.company_id,
    s.ship_name,
    s.ship_type,
    s.imo_number,
    s.flag,
    s.is_test_ship

  FROM public.ships s

  JOIN fmi_companies co
    ON co.company_id = s.company_id

  CROSS JOIN fmi_filter f

  WHERE
    (f.ship_id IS NULL OR s.ship_id = f.ship_id)

    AND (
      f.ship_type IS NULL
      OR s.ship_type = f.ship_type
    )

    AND (
      NOT f.exclude_test
      OR s.is_test_ship = false
    )
),

fmi_crew AS (
  SELECT
    u.user_id,
    u.seafarer_id,
    u.full_name,
    u.rank,
    u.status,
    u.company_id,
    u.ship_id,
    u.created_at,
    u.embarkation_date,
    u.disembarkation_date,
    u.trip,

    co.company_name,
    s.ship_name,
    s.ship_type,
    s.imo_number,
    s.flag,
    u.is_test_user

  FROM public.users u

  JOIN fmi_companies co
    ON co.company_id = u.company_id

  LEFT JOIN fmi_ships s
    ON s.ship_id = u.ship_id
   AND s.company_id = u.company_id

  CROSS JOIN fmi_filter f

  WHERE u.role_id = 4

    AND (
      (f.ship_id IS NULL AND f.ship_type IS NULL)
      OR s.ship_id IS NOT NULL
    )

    AND (
      f.rank IS NULL
      OR LOWER(COALESCE(u.rank, '')) = LOWER(f.rank)
    )

    AND (
      f.crew_status IS NULL
      OR LOWER(COALESCE(u.status, '')) =
         LOWER(f.crew_status)
    )

    AND (
      NOT f.exclude_test
      OR COALESCE(u.is_test_user, false) = false
    )

    AND (
      NOT f.exclude_test
      OR u.ship_id IS NULL
      OR s.ship_id IS NOT NULL
    )
),

-- TRAINING FACTS
fmi_training_facts AS (
  SELECT
    ce.user_id,
    ce.course_id,
    ce.enrolled_at,
    ce.completed_at,
    ce.status,
    ce.completion_status,
    ce.assigned,
    ce.certificate_issued

  FROM public.course_enrollments ce

  JOIN fmi_crew u
    ON u.user_id = ce.user_id

  JOIN public.courses cr
    ON cr.id = ce.course_id
    AND cr.deleted_at IS NULL

  CROSS JOIN fmi_filter f

  WHERE (
    cr.company_id IS NULL
    OR cr.company_id = u.company_id
  )

    AND (
      f.date_from IS NULL
      OR ce.enrolled_at >= f.date_from
    )

    AND (
      f.date_to IS NULL
      OR ce.enrolled_at < f.date_to + INTERVAL '1 day'
    )
),

-- ASSESSMENT FACTS
fmi_attempt_facts AS (
  SELECT
    aa.user_id,
    aa.assessment_id,
    aa.status,
    aa.is_passed,
    aa.percentage,
    aa.started_at,
    aa.submitted_at,
    aa.attempt_number

  FROM public.assessment_attempts aa

  JOIN fmi_crew u
    ON u.user_id = aa.user_id

  JOIN public.assessments a
    ON a.assessment_id = aa.assessment_id
    AND a.is_deleted = false

  CROSS JOIN fmi_filter f

  WHERE (
    a.company_id IS NULL
    OR a.company_id = u.company_id
  )

    AND (
      f.date_from IS NULL
      OR aa.started_at >= f.date_from
    )

    AND (
      f.date_to IS NULL
      OR aa.started_at < f.date_to + INTERVAL '1 day'
    )
),

-- CERTIFICATE FACTS
fmi_certificate_facts AS (
  SELECT
    cert.user_id,
    cert.certificate_id,
    cert.issue_date,
    cert.expiry_date,

    ${fmiCertificateStatusSql("cert")} AS computed_status

  FROM public.certificates cert

  JOIN fmi_crew u
    ON u.user_id = cert.user_id

  WHERE (
    cert.company_id IS NULL
    OR cert.company_id = u.company_id
  )
),

-- TRAINING AGGREGATE PER USER
fmi_training_user AS (
  SELECT
    t.user_id,

    COUNT(*)::int AS training_enrolments,

    COUNT(*) FILTER (
      WHERE t.status <> 'cancelled'
    )::int AS training_eligible,

    COUNT(*) FILTER (
      WHERE t.status <> 'cancelled'
        AND t.completion_status = 'completed'
    )::int AS training_completed,

    COUNT(*) FILTER (
      WHERE t.status <> 'cancelled'
        AND t.completion_status = 'in_progress'
    )::int AS training_in_progress,

    COUNT(*) FILTER (
      WHERE t.assigned = true
    )::int AS training_assigned

  FROM fmi_training_facts t

  GROUP BY t.user_id
),

-- ASSESSMENT AGGREGATE PER USER
fmi_assessment_user AS (
  SELECT
    a.user_id,

    COUNT(*)::int AS assessment_attempts,

    COUNT(*) FILTER (
      WHERE a.status = 'evaluated'
        AND a.is_passed IS NOT NULL
    )::int AS assessment_evaluated,

    COUNT(*) FILTER (
      WHERE a.status = 'evaluated'
        AND a.is_passed IS TRUE
    )::int AS assessment_passed,

    COUNT(*) FILTER (
      WHERE a.status = 'evaluated'
        AND a.is_passed IS FALSE
    )::int AS assessment_failed,

    COALESCE(
      SUM(a.percentage) FILTER (
        WHERE a.status = 'evaluated'
          AND a.percentage IS NOT NULL
      ),
      0
    )::numeric AS assessment_score_sum,

    COUNT(a.percentage) FILTER (
      WHERE a.status = 'evaluated'
    )::int AS assessment_score_count

  FROM fmi_attempt_facts a

  GROUP BY a.user_id
),

-- CERTIFICATE AGGREGATE PER USER
fmi_certificate_user AS (
  SELECT
    c.user_id,

    COUNT(*)::int AS certificates_held,

    COUNT(*) FILTER (
      WHERE c.computed_status IN (
        'active',
        'expiring_soon'
      )
    )::int AS certificates_valid,

    COUNT(*) FILTER (
      WHERE c.computed_status = 'expired'
    )::int AS certificates_expired,

    COUNT(*) FILTER (
      WHERE c.computed_status = 'expiring_soon'
    )::int AS certificates_expiring_soon,

    COUNT(*) FILTER (
      WHERE c.computed_status = 'revoked'
    )::int AS certificates_revoked,

    COUNT(*) FILTER (
      WHERE c.computed_status IN ('expired', 'revoked', 'failed')
    )::int AS certificate_hard_stops

  FROM fmi_certificate_facts c

  GROUP BY c.user_id
),

-- CATEGORY MATRIX; join through scoped USERS, not stale m.company_id/ship_id.
fmi_matrix_user AS (
  SELECT
    m.user_id,
    m.readiness_score,
    (${fmiMatrixTotalSql("m", "assigned")})::int AS matrix_total_assigned,
    (${fmiMatrixTotalSql("m", "completed")})::int AS matrix_total_completed
  FROM public.user_competency_matrix m
  JOIN fmi_crew u ON u.user_id = m.user_id
),

-- COMBINED RESULTS - ONE ROW PER CREW MEMBER
fmi_per_crew AS (
  SELECT
    u.*,

    COALESCE(t.training_enrolments, 0)
      AS training_enrolments,

    COALESCE(t.training_eligible, 0)
      AS training_eligible,

    COALESCE(t.training_completed, 0)
      AS training_completed,

    COALESCE(t.training_in_progress, 0)
      AS training_in_progress,

    COALESCE(t.training_assigned, 0)
      AS training_assigned,

    COALESCE(a.assessment_attempts, 0)
      AS assessment_attempts,

    COALESCE(a.assessment_evaluated, 0)
      AS assessment_evaluated,

    COALESCE(a.assessment_passed, 0)
      AS assessment_passed,

    COALESCE(a.assessment_failed, 0)
      AS assessment_failed,

    COALESCE(a.assessment_score_sum, 0)
      AS assessment_score_sum,

    COALESCE(a.assessment_score_count, 0)
      AS assessment_score_count,

    COALESCE(c.certificates_held, 0)
      AS certificates_held,

    COALESCE(c.certificates_valid, 0)
      AS certificates_valid,

    COALESCE(c.certificates_expired, 0)
      AS certificates_expired,

    COALESCE(c.certificates_expiring_soon, 0)
      AS certificates_expiring_soon,

    COALESCE(c.certificates_revoked, 0)
      AS certificates_revoked,

    COALESCE(c.certificate_hard_stops, 0)
      AS certificate_hard_stops,

    m.readiness_score AS readiness_score,
    COALESCE(m.matrix_total_assigned, 0) AS matrix_total_assigned,
    COALESCE(m.matrix_total_completed, 0) AS matrix_total_completed,

    CASE
      WHEN COALESCE(c.certificate_hard_stops, 0) > 0 THEN 'not_ready'
      WHEN m.readiness_score IS NULL THEN 'unassessed'
      WHEN m.readiness_score >= 80 THEN 'ready'
      WHEN m.readiness_score >= 50 THEN 'conditionally_ready'
      ELSE 'not_ready'
    END AS readiness_status

  FROM fmi_crew u

  LEFT JOIN fmi_training_user t
    ON t.user_id = u.user_id

  LEFT JOIN fmi_assessment_user a
    ON a.user_id = u.user_id

  LEFT JOIN fmi_certificate_user c
    ON c.user_id = u.user_id

  LEFT JOIN fmi_matrix_user m
    ON m.user_id = u.user_id
)
`;

// ============================================================
// COMMON KPI AGGREGATION
// ============================================================

function fmiRollupSql(alias = "p") {
  return `
    COUNT(${alias}.user_id)::int AS crew_count,

    COUNT(${alias}.user_id) FILTER (
      WHERE LOWER(
        COALESCE(${alias}.status, '')
      ) = 'onboard'
    )::int AS onboard_crew,

    COUNT(${alias}.user_id) FILTER (
      WHERE LOWER(
        COALESCE(${alias}.status, '')
      ) = 'offboard'
    )::int AS offboard_crew,

    COALESCE(
      SUM(${alias}.training_eligible), 0
    )::int AS training_enrolments,

    COALESCE(
      SUM(${alias}.training_completed), 0
    )::int AS training_completions,

    ROUND(
      100.0 * SUM(${alias}.training_completed)
      / NULLIF(
        SUM(${alias}.training_eligible), 0
      ),
      2
    )::float8 AS training_completion_rate,

    COALESCE(
      SUM(${alias}.assessment_attempts), 0
    )::int AS assessment_attempts,

    COALESCE(
      SUM(${alias}.assessment_evaluated), 0
    )::int AS evaluated_attempts,

    COALESCE(
      SUM(${alias}.assessment_passed), 0
    )::int AS passed_attempts,

    ROUND(
      100.0 * SUM(${alias}.assessment_passed)
      / NULLIF(
        SUM(${alias}.assessment_evaluated), 0
      ),
      2
    )::float8 AS assessment_pass_rate,

    ROUND(
      SUM(${alias}.assessment_score_sum)
      / NULLIF(
        SUM(${alias}.assessment_score_count), 0
      ),
      2
    )::float8 AS average_assessment_score,

    COALESCE(
      SUM(${alias}.certificates_held), 0
    )::int AS certificates_held,

    COALESCE(
      SUM(${alias}.certificates_valid), 0
    )::int AS valid_certificates,

    COALESCE(
      SUM(${alias}.certificates_expired), 0
    )::int AS expired_certificates,

    COALESCE(
      SUM(${alias}.certificates_expiring_soon), 0
    )::int AS expiring_soon_certificates,

    ROUND(
      100.0 * SUM(${alias}.certificates_valid)
      / NULLIF(
        SUM(${alias}.certificates_held), 0
      ),
      2
    )::float8 AS certificate_validity_percentage,

    COUNT(${alias}.user_id) FILTER (
      WHERE ${alias}.readiness_status = 'ready'
    )::int AS ready_crew,

    COUNT(${alias}.user_id) FILTER (
      WHERE ${alias}.readiness_status = 'conditionally_ready'
    )::int AS conditionally_ready_crew,

    COUNT(${alias}.user_id) FILTER (
      WHERE ${alias}.readiness_status = 'not_ready'
    )::int AS not_ready_crew,

    COUNT(${alias}.user_id) FILTER (
      WHERE ${alias}.readiness_status = 'unassessed'
    )::int AS unassessed_crew,

    COUNT(${alias}.user_id) FILTER (
      WHERE ${alias}.certificate_hard_stops > 0
    )::int AS crew_with_certificate_hard_stops,

    ROUND(
      100.0 * COUNT(${alias}.user_id) FILTER (
        WHERE ${alias}.readiness_status = 'ready'
      ) / NULLIF(COUNT(${alias}.user_id) FILTER (
        WHERE ${alias}.readiness_status <> 'unassessed'
      ), 0), 2
    )::float8 AS readiness_percentage,

    ROUND(AVG(${alias}.readiness_score), 2)::float8
      AS average_matrix_readiness_score,

    COALESCE(SUM(${alias}.matrix_total_assigned), 0)::int
      AS matrix_total_assigned,

    COALESCE(SUM(${alias}.matrix_total_completed), 0)::int
      AS matrix_total_completed
  `;
}

const fmiDefinitions = {
  pagination: false,

  population: "users.role_id = 4",

  grouping: "current_company_and_ship_of_seafarer",

  trainingRate:
    "completed_non_cancelled_enrollments / non_cancelled_enrollments",

  assessmentPassRate:
    "passed_evaluated_attempts / evaluated_attempts_with_result",

  assessmentScore:
    "average_percentage_across_evaluated_attempts",

  certificateValidity:
    "valid_certificates / certificates_held_not_mandatory_compliance",

  certificateExpiringSoonDays: 14,

  reportingDates:
    "training_enrolled_at_assessment_started_at_certificates_are_current_validity_snapshot",

  activeShipStatusAvailable: false,
  trueActiveLearnerMeasureAvailable: false,
  departmentAnalyticsAvailable: false,
  competencyScoreAvailable: false,
  mandatoryComplianceAvailable: false,
  verifiedReadinessAvailable: false,
  storedMatrixReadinessAvailable: true,
  readinessClassification: "score_gte_80_ready_score_gte_50_conditionally_ready_otherwise_not_ready_certificate_hard_stop_not_ready",
  readinessRateDenominator: "classified_crew_excluding_unassessed",
  matrixCountsMeaning: "training_assignments_and_completions_by_category_not_verified_professional_competency",
  matrixShipAndCompanySource: "current_users_not_matrix_snapshot",
  incidentAnalyticsAvailable: false,
};


/*
  FMI 360 - TRAINING ANALYTICS HELPERS

  Tables:
    courses
    course_enrollments
    users
    company
    ships

  Authorized roles:
    1 - Super Admin
    2 - Company Admin

  All reporting APIs return unpaginated data.
*/

function trainingHttpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function trainingDate(value, field) {
  if (value == null || value === "") return null;

  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value)
  ) {
    throw trainingHttpError(
      400,
      `${field} must be YYYY-MM-DD`
    );
  }

  const date = new Date(`${value}T00:00:00Z`);

  if (
    Number.isNaN(date.getTime()) ||
    date.toISOString().slice(0, 10) !== value
  ) {
    throw trainingHttpError(400, `Invalid ${field}`);
  }

  return value;
}

function trainingPositiveId(value, field) {
  if (value == null || value === "") return null;

  if (!/^[1-9]\d*$/.test(String(value))) {
    throw trainingHttpError(400, `Invalid ${field}`);
  }

  const number = Number(value);

  if (!Number.isSafeInteger(number)) {
    throw trainingHttpError(400, `Invalid ${field}`);
  }

  return number;
}

function buildTrainingAnalyticsScope(req) {
  const role = Number(req.user?.role_id);

  if (![1, 2].includes(role)) {
    throw trainingHttpError(
      403,
      "Training analytics access denied"
    );
  }

  const {
    companyId,
    shipId,
    courseId,
    department,
    contentMode,
    dateFrom,
    dateTo,
  } = req.query || {};

  const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  if (companyId && !UUID_RE.test(String(companyId))) {
    throw trainingHttpError(400, "Invalid companyId");
  }

  if (
    contentMode &&
    !["course", "single_training"].includes(contentMode)
  ) {
    throw trainingHttpError(400, "Invalid contentMode");
  }

  const selectedShip = trainingPositiveId(shipId, "shipId");
  const selectedCourse = trainingPositiveId(courseId, "courseId");

  const from = trainingDate(dateFrom, "dateFrom");
  const to = trainingDate(dateTo, "dateTo");

  if (from && to && from > to) {
    throw trainingHttpError(
      400,
      "dateFrom cannot be after dateTo"
    );
  }

  const params = [];
  const courseWhere = ["c.deleted_at IS NULL"];
  const enrollmentWhere = ["TRUE"];

  const add = (value) => {
    params.push(value);
    return `$${params.length}`;
  };

  // Company restriction
  let effectiveCompany = null;

  if (role === 2) {
    effectiveCompany = req.user?.company_id;

    if (!effectiveCompany) {
      throw trainingHttpError(
        403,
        "Company scope missing"
      );
    }

    if (
      companyId &&
      String(companyId).toLowerCase() !==
        String(effectiveCompany).toLowerCase()
    ) {
      throw trainingHttpError(
        403,
        "Cannot access another company's data"
      );
    }
  } else if (companyId) {
    effectiveCompany = companyId;
  }

  if (effectiveCompany) {
    const p = add(effectiveCompany);

    // Global courses remain visible to authorized users.
    courseWhere.push(
      `(c.company_id = ${p} OR c.company_id IS NULL)`
    );

    // Actual learner data belongs to the selected company.
    enrollmentWhere.push(`u.company_id = ${p}`);
  }

  // Ship restriction
  let effectiveShip = selectedShip;

  if (effectiveShip != null) {
    const p = add(effectiveShip);

    courseWhere.push(
      `(c.ship_id = ${p} OR c.ship_id IS NULL)`
    );

    enrollmentWhere.push(`u.ship_id = ${p}`);
  }

  if (selectedCourse != null) {
    courseWhere.push(
      `c.id = ${add(selectedCourse)}`
    );
  }

  if (department) {
    courseWhere.push(
      `c.department = ${add(String(department))}`
    );
  }

  if (contentMode) {
    courseWhere.push(
      `c.content_mode = ${add(contentMode)}`
    );
  }

  const enrollmentWhereNoDate = enrollmentWhere.join(" AND ");
  let dateFromParam = null;
  let dateToParam = null;

  // Reporting period is based on enrollment date.
  if (from) {
    dateFromParam = add(from);
    enrollmentWhere.push(`ce.enrolled_at >= ${dateFromParam}::date`);
  }

  if (to) {
    dateToParam = add(to);
    enrollmentWhere.push(`ce.enrolled_at < (${dateToParam}::date + INTERVAL '1 day')`);
  }

  return {
    params,
    courseWhere: courseWhere.join(" AND "),
    enrollmentWhere: enrollmentWhere.join(" AND "),
    enrollmentWhereNoDate,
    dateFromParam,
    dateToParam,
    effectiveCompany,
    effectiveShip,
    from,
    to,
  };
}

function trainingAnalyticsCte(scope) {
  return `
    WITH scoped_courses AS (
      SELECT c.*
      FROM public.courses c
      WHERE ${scope.courseWhere}
    ),

    scoped_enrollments AS (
      SELECT
        ce.id AS enrollment_id,
        ce.course_id,
        ce.user_id,
        ce.enrolled_at,
        ce.enrolled_by,
        ce.assigned,
        ce.status,
        ce.completion_status,
        ce.completed_at,
        ce.certificate_issued,

        u.full_name,
        u.seafarer_id,
        u.rank,
        u.company_id AS user_company_id,
        u.ship_id AS user_ship_id,

        co.company_name,
        sh.ship_name,

        CASE
          WHEN ce.status = 'cancelled'
            THEN 'cancelled'

          WHEN ce.completion_status = 'completed'
            THEN 'completed'

          WHEN ce.completion_status = 'in_progress'
            THEN 'in_progress'

          ELSE 'not_started'
        END AS learning_status

      FROM public.course_enrollments ce

      JOIN scoped_courses c
        ON c.id = ce.course_id

      JOIN public.users u
        ON u.user_id = ce.user_id

      LEFT JOIN public.company co
        ON co.company_id = u.company_id

      LEFT JOIN public.ships sh
        ON sh.ship_id = u.ship_id

      WHERE ${scope.enrollmentWhere}
    )
  `;
}

function trainingAnalyticsSendError(res, error, name) {
  if (error.status >= 400 && error.status < 500) {
    return res.status(error.status).json({
      success: false,
      message: error.message,
    });
  }

  console.error(`${name}:`, error);

  return res.status(500).json({
    success: false,
    message: "Failed to load training analytics",
  });
}

const ASSESSMENT_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function assessmentAnalyticsError(status, message) {
  return Object.assign(new Error(message), { status });
}

function assessmentAnalyticsDate(value, name) {
  if (value == null || value === "") return null;

  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value)
  ) {
    throw assessmentAnalyticsError(
      400, `${name} must be YYYY-MM-DD`
    );
  }

  const date = new Date(`${value}T00:00:00Z`);

  if (
    Number.isNaN(date.getTime()) ||
    date.toISOString().slice(0, 10) !== value
  ) {
    throw assessmentAnalyticsError(
      400, `Invalid ${name}`
    );
  }

  return value;
}

// Produces one shared parameter set for all analytics queries.
function buildAssessmentAnalyticsScope(req) {
  const role = Number(req.user?.role_id);
  const company = req.user?.company_id;
  const ship = req.user?.ship_id;

  if (![1, 2].includes(role)) {
    throw assessmentAnalyticsError(403, "Access denied");
  }

  const {
    companyId, shipId, assessmentId,
    assessmentType, category, dateFrom, dateTo,
  } = req.query || {};

  const params = [];
  const add = (value) => {
    params.push(value);
    return `$${params.length}`;
  };

  const aWhere = ["a.is_deleted = false"];
  const uWhere = ["TRUE"];
  const assignmentWhere = ["TRUE"];
  const periodWhere = [];

  if (companyId && !ASSESSMENT_UUID.test(String(companyId))) {
    throw assessmentAnalyticsError(400, "Invalid companyId");
  }

  if (assessmentId && !ASSESSMENT_UUID.test(String(assessmentId))) {
    throw assessmentAnalyticsError(400, "Invalid assessmentId");
  }

  let selectedShip = null;

  if (shipId != null && shipId !== "") {
    if (!/^[1-9]\d*$/.test(String(shipId))) {
      throw assessmentAnalyticsError(400, "Invalid shipId");
    }

    selectedShip = Number(shipId);

    if (!Number.isSafeInteger(selectedShip)) {
      throw assessmentAnalyticsError(400, "Invalid shipId");
    }
  }

  if (role === 2) {
    if (!company) {
      throw assessmentAnalyticsError(403, "Company scope missing");
    }

    if (
      companyId &&
      String(companyId).toLowerCase() !==
        String(company).toLowerCase()
    ) {
      throw assessmentAnalyticsError(403, "Forbidden company");
    }

    const p = add(company);
    // Global assessments are accessible within own user scope.
    aWhere.push(`(a.company_id = ${p} OR a.company_id IS NULL)`);
    uWhere.push(`u.company_id = ${p}`);
    assignmentWhere.push(`asg.company_id = ${p}`);
  } else if (companyId) {
    const p = add(companyId);
    aWhere.push(`(a.company_id = ${p} OR a.company_id IS NULL)`);
    uWhere.push(`u.company_id = ${p}`);
    assignmentWhere.push(`asg.company_id = ${p}`);
  }

  if (selectedShip != null) {
    const p = add(selectedShip);
    aWhere.push(`(a.ship_id = ${p} OR a.ship_id IS NULL)`);
    uWhere.push(`u.ship_id = ${p}`);
    assignmentWhere.push(`asg.ship_id = ${p}`);
  }

  if (assessmentId) {
    aWhere.push(`a.assessment_id = ${add(assessmentId)}`);
  }

  if (assessmentType) {
    if (!["mcq_single", "mcq_multiple", "subjective"].includes(assessmentType)) {
      throw assessmentAnalyticsError(400, "Invalid assessmentType");
    }
    aWhere.push(`a.assessment_type = ${add(assessmentType)}`);
  }

  if (category) {
    aWhere.push(`a.category = ${add(String(category))}`);
  }

  const from = assessmentAnalyticsDate(dateFrom, "dateFrom");
  const to = assessmentAnalyticsDate(dateTo, "dateTo");

  if (from && to && from > to) {
    throw assessmentAnalyticsError(400, "Invalid reporting period");
  }

  if (from) {
    const p = add(from);
    periodWhere.push(`aa.started_at >= ${p}::date`);
    // Assignment created_at filter uses the same reporting period.
  }

  if (to) {
    const p = add(to);
    periodWhere.push(
      `aa.started_at < (${p}::date + INTERVAL '1 day')`
    );
  }

  // Separate clauses for assignment creation date.
  const assignmentPeriod = [];
  if (from) {
    const idx = params.findIndex((v) => v === from) + 1;
    assignmentPeriod.push(`asg.created_at >= $${idx}::date`);
  }
  if (to) {
    // Find the last matching occurrence if dates are equal.
    const idx = params.lastIndexOf(to) + 1;
    assignmentPeriod.push(
      `asg.created_at < ($${idx}::date + INTERVAL '1 day')`
    );
  }

  return {
    params,
    aWhere: aWhere.join(" AND "),
    uWhere: uWhere.join(" AND "),
    assignmentWhere: assignmentWhere.join(" AND "),
    periodWhere: periodWhere.length
      ? periodWhere.join(" AND ") : "TRUE",
    assignmentPeriod: assignmentPeriod.length
      ? assignmentPeriod.join(" AND ") : "TRUE",
  };
}

// Shared CTE: all assessments in scope, and the related
// attempts belonging to authorized users.
//
// Assessment counts include zero-attempt assessments.
// Attempt counts are scoped to current user company/ship.
function assessmentAnalyticsCte(scope) {
  return `
    WITH scoped_assessments AS (
      SELECT a.*
      FROM public.assessments a
      WHERE ${scope.aWhere}
    ),
    scoped_attempts AS (
      SELECT
        aa.*,
        u.company_id AS user_company_id,
        u.ship_id AS user_ship_id
      FROM public.assessment_attempts aa
      JOIN scoped_assessments a
        ON a.assessment_id = aa.assessment_id
      JOIN public.users u
        ON u.user_id = aa.user_id
      WHERE ${scope.uWhere}
        AND ${scope.periodWhere}
    )
  `;
}

function assessmentAnalyticsSendError(res, error, name) {
  if (error.status >= 400 && error.status < 500) {
    return res.status(error.status).json({
      success: false,
      message: error.message,
    });
  }

  console.error(`${name}:`, error);

  return res.status(500).json({
    success: false,
    message: "Failed to fetch assessment analytics",
  });
}
// ------------------------------------------------------------
// 1. HTTP ERROR
// ------------------------------------------------------------

function httpError(status, message) {
    const error = new Error(message);
    error.status = status;
    return error;
}

// ------------------------------------------------------------
// 2. VALIDATE DATE
// ------------------------------------------------------------

function parseDate(raw, name) {
    if (raw == null || raw === "") {
        return null;
    }

    if (
        typeof raw !== "string" ||
        !DATE_RE.test(raw)
    ) {
        throw httpError(
            400,
            `${name} must be in YYYY-MM-DD format`
        );
    }

    const date = new Date(`${raw}T00:00:00Z`);

    if (
        Number.isNaN(date.getTime()) ||
        date.toISOString().slice(0, 10) !== raw
    ) {
        throw httpError(
            400,
            `${name} must be a valid date`
        );
    }

    return raw;
}

// ------------------------------------------------------------
// 3. VALIDATE POSITIVE INTEGER
// ------------------------------------------------------------

function parseIntParam(
    raw,
    name,
    fallback,
    max = 10000
) {
    if (raw == null || raw === "") {
        return fallback;
    }

    if (!/^\d+$/.test(String(raw))) {
        throw httpError(
            400,
            `${name} must be a positive integer`
        );
    }

    const value = Number(raw);

    if (
        !Number.isSafeInteger(value) ||
        value < 1 ||
        value > max
    ) {
        throw httpError(
            400,
            `${name} must be between 1 and ${max}`
        );
    }

    return value;
}

// ------------------------------------------------------------
// 4. ROLE-BASED COMPANY AND SHIP SCOPE
// ------------------------------------------------------------
// Role 1: All companies and ships
// Role 2: Only own company
// Role 3/4: Not authorized
//
// Optional filters:
// companyId
// shipId
// dateFrom
// dateTo
//
// dateFrom/dateTo filter certificate issue_date.
// ------------------------------------------------------------

function roleScope(
    req,
    tableAlias = "c",
    options = {}
) {
    const role = Number(req.user?.role_id);

    const userCompany = req.user?.company_id;
    const userShip = req.user?.ship_id;

    const {
        companyId,
        shipId,
        dateFrom,
        dateTo,
    } = req.query || {};

    const includeDates =
        options.includeDates !== false;

    const where = [];
    const params = [];

    function add(sql, value) {
        params.push(value);

        where.push(
            sql.replace("?", `$${params.length}`)
        );
    }

    // Check authorized roles
    if (
        ![
            ROLE_SUPERADMIN,
            ROLE_ADMIN,
        ].includes(role)
    ) {
        throw httpError(
            403,
            "You are not authorized to access analytics"
        );
    }

    // Validate company UUID
    if (
        companyId != null &&
        companyId !== "" &&
        !UUID_RE.test(String(companyId))
    ) {
        throw httpError(
            400,
            "companyId must be a valid UUID"
        );
    }

    // Validate ship ID
    const selectedShip =
        shipId != null && shipId !== ""
            ? parseIntParam(
                shipId,
                "shipId",
                null
            )
            : null;

    // COMPANY ADMIN
    if (role === ROLE_ADMIN) {
        if (!userCompany) {
            throw httpError(
                403,
                "Authenticated company is missing"
            );
        }

        if (
            companyId &&
            String(companyId).toLowerCase() !==
            String(userCompany).toLowerCase()
        ) {
            throw httpError(
                403,
                "Cannot access another company"
            );
        }

        add(
            `${tableAlias}.company_id = ?`,
            userCompany
        );
    }

    // SUPER ADMIN
    if (
        role === ROLE_SUPERADMIN &&
        companyId
    ) {
        add(
            `${tableAlias}.company_id = ?`,
            companyId
        );
    }

    // Ship filtering for Role 1 and Role 2
    if (
        selectedShip != null
    ) {
        add(
            `${tableAlias}.ship_id = ?`,
            selectedShip
        );
    }

    // Date range
    if (includeDates) {
        const from = parseDate(
            dateFrom,
            "dateFrom"
        );

        const to = parseDate(
            dateTo,
            "dateTo"
        );

        if (from && to && from > to) {
            throw httpError(
                400,
                "dateFrom must not be after dateTo"
            );
        }

        if (from) {
            add(
                `${tableAlias}.issue_date >= ?::date`,
                from
            );
        }

        if (to) {
            add(
                `${tableAlias}.issue_date < (?::date + INTERVAL '1 day')`,
                to
            );
        }
    }

    return {
        where: where.length
            ? where.join(" AND ")
            : "TRUE",
        params,
    };
}

// ------------------------------------------------------------
// 5. COMPUTE CERTIFICATE STATUS
// ------------------------------------------------------------
// Priority:
// 1. Revoked
// 2. Expired
// 3. Expiring soon (within 14 days)
// 4. Active
//
// NULL expiry_date is treated as active to match
// the existing certificatesController.
// ------------------------------------------------------------

function statusSql(alias = "c") {
    return `
    CASE
      WHEN COALESCE((to_jsonb(${alias})->>'is_revoked')::boolean, false)
        OR LOWER(COALESCE(${alias}.status, 'active')) = 'revoked'
        THEN 'revoked'

      WHEN LOWER(COALESCE(${alias}.status, '')) = 'failed'
        THEN 'failed'

      WHEN LOWER(COALESCE(${alias}.status, '')) = 'expired'
        THEN 'expired'

      WHEN ${alias}.expiry_date IS NOT NULL
        AND ${alias}.expiry_date < CURRENT_DATE
        THEN 'expired'

      WHEN ${alias}.expiry_date IS NOT NULL
        AND ${alias}.expiry_date
          <= CURRENT_DATE + ${EXPIRING_SOON_DAYS}
        THEN 'expiring_soon'

      ELSE 'active'
    END
  `;
}

// ------------------------------------------------------------
// 6. BASE CERTIFICATE DATASET
// ------------------------------------------------------------

function baseCte(scope) {
    return `
    WITH scoped AS (
      SELECT
        c.*,
        ${statusSql("c")} AS computed_status
      FROM public.certificates c
      WHERE ${scope.where}
    )
  `;
}

// ------------------------------------------------------------
// 7. REUSABLE CERTIFICATE TOTALS
// ------------------------------------------------------------
// Always reference the scoped alias explicitly.
// This avoids ambiguous SQL column references.
// ------------------------------------------------------------

function totalsSql(alias = "s") {
    return `
    COUNT(*)::int AS total,

    COUNT(*) FILTER (
      WHERE ${alias}.computed_status = 'active'
    )::int AS active,

    COUNT(*) FILTER (
      WHERE ${alias}.computed_status = 'expiring_soon'
    )::int AS expiring_soon,

    COUNT(*) FILTER (
      WHERE ${alias}.computed_status = 'expired'
    )::int AS expired,

    COUNT(*) FILTER (
      WHERE ${alias}.computed_status = 'revoked'
    )::int AS revoked,

    COUNT(*) FILTER (
      WHERE ${alias}.computed_status
        IN ('active', 'expiring_soon')
    )::int AS valid,

    ROUND(
      100.0 * COUNT(*) FILTER (
        WHERE ${alias}.computed_status
          IN ('active', 'expiring_soon')
      ) / NULLIF(COUNT(*), 0),
      2
    ) AS valid_percentage
  `;
}

// ------------------------------------------------------------
// 8. COMMON ERROR HANDLER
// ------------------------------------------------------------

function sendError(res, error, functionName) {
    if (
        error.status &&
        error.status >= 400 &&
        error.status < 500
    ) {
        return res.status(error.status).json({
            success: false,
            error: error.message,
        });
    }

    console.error(
        `${functionName} error:`,
        error
    );

    return res.status(500).json({
        success: false,
        error: "Failed to load certificate analytics",
    });
}


/** Single enforcement point for every analytics handler, even if routed elsewhere. */
async function verifyAnalyticsRequest(req) {
  const role = Number(req.user?.role_id);
  if (role !== 1 && role !== 2) {
    throw httpError(403, "Analytics access is restricted to Roles 1 and 2");
  }
  if (role === 2 && !req.user?.company_id) {
    throw httpError(403, "Authenticated company is missing");
  }
  if (
    role === 2 && req.query?.companyId &&
    String(req.query.companyId).toLowerCase() !== String(req.user.company_id).toLowerCase()
  ) {
    throw httpError(403, "Cannot access another company");
  }
  const raw = req.query?.shipId;
  if (raw == null || raw === "") return;
  if (!/^[1-9]\d*$/.test(String(raw)) || !Number.isSafeInteger(Number(raw))) {
    throw httpError(400, "Invalid shipId");
  }
  const { rowCount } = await db.query(
    `SELECT 1 FROM public.ships
     WHERE ship_id = $1 AND ($2::uuid IS NULL OR company_id = $2::uuid)
     LIMIT 1`,
    [Number(raw), role === 2 ? req.user.company_id : null]
  );
  if (!rowCount) throw httpError(role === 2 ? 403 : 404, "Ship not found or outside your company");
}

// ============================================================
// CERTIFICATE ANALYTICS - API 1
// ============================================================
// GET /api/analytics/certificates/overview
//
// Returns:
// - Overall certificate summary
// - Certificate types
// - Company-wise data
// - Ship-wise data
// - Rank-wise data
// - Monthly certificate issuance
// ============================================================

export const getCertificateOverviewAnalytics =
    async (req, res) => {
        try {
      await verifyAnalyticsRequest(req);
            const scope = roleScope(req, "c");
            const cte = baseCte(scope);

            // 1. Overall certificate summary
            const summaryQuery = `
        ${cte}

        SELECT
          ${totalsSql("s")}

        FROM scoped s
      `;

            // 2. Certificate type distribution
            const typeQuery = `
        ${cte}

        SELECT
          s.certificate_type AS type,
          ${totalsSql("s")}

        FROM scoped s

        GROUP BY s.certificate_type

        ORDER BY total DESC
      `;

            // 3. Company-wise analytics
            const companyQuery = `
        ${cte}

        SELECT
          s.company_id,

          COALESCE(
            MAX(co.company_name),
            MAX(s.company_name_snapshot),
            'Unassigned'
          ) AS company_name,

          ${totalsSql("s")}

        FROM scoped s

        LEFT JOIN public.company co
          ON co.company_id = s.company_id

        GROUP BY s.company_id

        ORDER BY total DESC
      `;

            // 4. Ship-wise analytics
            const shipQuery = `
        ${cte}

        SELECT
          s.ship_id,

          COALESCE(
            MAX(sh.ship_name),
            MAX(s.ship_name_snapshot),
            'Unassigned'
          ) AS ship_name,

          ${totalsSql("s")}

        FROM scoped s

        LEFT JOIN public.ships sh
          ON sh.ship_id = s.ship_id

        GROUP BY s.ship_id

        ORDER BY total DESC
      `;

            // 5. Rank-wise analytics
            const rankQuery = `
        ${cte}

        SELECT
          COALESCE(
            u.rank,
            'Unknown'
          ) AS rank,

          ${totalsSql("s")}

        FROM scoped s

        LEFT JOIN public.users u
          ON u.user_id = s.user_id

        GROUP BY
          COALESCE(u.rank, 'Unknown')

        ORDER BY total DESC
      `;

            // 6. Monthly issuance trends
            const trendQuery = `
        ${cte}

        SELECT
          TO_CHAR(
            DATE_TRUNC(
              'month',
              s.issue_date
            ),
            'YYYY-MM'
          ) AS month,

          COUNT(*)::int AS total,

          COUNT(*) FILTER (
            WHERE s.certificate_type = 'course'
          )::int AS course,

          COUNT(*) FILTER (
            WHERE s.certificate_type = 'assessment'
          )::int AS assessment,

          COUNT(*) FILTER (
            WHERE s.certificate_type = 'training'
          )::int AS training

        FROM scoped s

        GROUP BY
          DATE_TRUNC(
            'month',
            s.issue_date
          )

        ORDER BY
          DATE_TRUNC(
            'month',
            s.issue_date
          )
      `;

            const [
                summary,
                types,
                companies,
                ships,
                ranks,
                monthly,
            ] = await Promise.all([
                db.query(summaryQuery, scope.params),
                db.query(typeQuery, scope.params),
                db.query(companyQuery, scope.params),
                db.query(shipQuery, scope.params),
                db.query(rankQuery, scope.params),
                db.query(trendQuery, scope.params),
            ]);

            return res.status(200).json({
                success: true,

                data: {
                    summary: summary.rows[0],

                    byType: types.rows,

                    byCompany: companies.rows,

                    byShip: ships.rows,

                    byRank: ranks.rows,

                    monthlyIssuance: monthly.rows,

                    definitions: {
                        expiringSoonDays: EXPIRING_SOON_DAYS,
                        grouping: "certificate_records",
                        dateFilter: "issue_date",
                        shipGrouping: "ship_at_issuance",
                        pagination: false,
                    },
                },
            });
        } catch (error) {
            return sendError(
                res,
                error,
                "getCertificateOverviewAnalytics"
            );
        }
    };

// ============================================================
// CERTIFICATE ANALYTICS - API 2
// ============================================================
// GET /api/analytics/certificates/renewals
//
// Returns:
// - Expired certificates
// - Expiring in 7/14/30/60/90 days
// - Complete renewal priority list
// - Crew details
// - Days until expiry
//
// No pagination.
// ============================================================

export const getCertificateRenewalAnalytics =
    async (req, res) => {
        try {
      await verifyAnalyticsRequest(req);
            const scope = roleScope(
                req,
                "c",
                { includeDates: false }
            );

            const days = parseIntParam(
                req.query.days,
                "days",
                30,
                365
            );

            const cte = baseCte(scope);

            // 1. Renewal summary
            const summaryQuery = `
        ${cte}

        SELECT
          COUNT(*) FILTER (
            WHERE s.computed_status <> 'revoked'
              AND s.expiry_date < CURRENT_DATE
          )::int AS expired,

          COUNT(*) FILTER (
            WHERE s.computed_status <> 'revoked'
              AND s.expiry_date
                BETWEEN CURRENT_DATE AND CURRENT_DATE + 7
          )::int AS expiring_in_7_days,

          COUNT(*) FILTER (
            WHERE s.computed_status <> 'revoked'
              AND s.expiry_date
                BETWEEN CURRENT_DATE AND CURRENT_DATE + 14
          )::int AS expiring_in_14_days,

          COUNT(*) FILTER (
            WHERE s.computed_status <> 'revoked'
              AND s.expiry_date
                BETWEEN CURRENT_DATE AND CURRENT_DATE + 30
          )::int AS expiring_in_30_days,

          COUNT(*) FILTER (
            WHERE s.computed_status <> 'revoked'
              AND s.expiry_date
                BETWEEN CURRENT_DATE AND CURRENT_DATE + 60
          )::int AS expiring_in_60_days,

          COUNT(*) FILTER (
            WHERE s.computed_status <> 'revoked'
              AND s.expiry_date
                BETWEEN CURRENT_DATE AND CURRENT_DATE + 90
          )::int AS expiring_in_90_days

        FROM scoped s
      `;

            // 2. Complete certificate renewal list
            const listQuery = `
        ${cte}

        SELECT
          s.certificate_id,
          s.certificate_uid,
          s.certificate_name,
          s.certificate_type,

          s.user_id,

          COALESCE(
            u.full_name,
            s.full_name_snapshot
          ) AS full_name,

          u.rank,

          s.company_id,

          COALESCE(
            co.company_name,
            s.company_name_snapshot
          ) AS company_name,

          s.ship_id,

          COALESCE(
            sh.ship_name,
            s.ship_name_snapshot
          ) AS ship_name,

          s.issue_date,
          s.expiry_date,
          s.computed_status,

          (
            s.expiry_date - CURRENT_DATE
          )::int AS days_until_expiry

        FROM scoped s

        LEFT JOIN public.users u
          ON u.user_id = s.user_id

        LEFT JOIN public.company co
          ON co.company_id = s.company_id

        LEFT JOIN public.ships sh
          ON sh.ship_id = s.ship_id

        WHERE
          s.computed_status <> 'revoked'

          AND s.expiry_date IS NOT NULL

          AND s.expiry_date <=
            CURRENT_DATE +
            $${scope.params.length + 1}::int

        ORDER BY
          s.expiry_date ASC,
          s.certificate_id DESC
      `;

            const [summary, list] =
                await Promise.all([
                    db.query(
                        summaryQuery,
                        scope.params
                    ),

                    db.query(
                        listQuery,
                        [
                            ...scope.params,
                            days,
                        ]
                    ),
                ]);

            return res.status(200).json({
                success: true,

                data: {
                    summary: summary.rows[0],

                    totalRecords: list.rows.length,

                    renewalList: list.rows,

                    definitions: {
                        selectedWindowDays: days,
                        includesExpired: true,
                        expiringSoonDays: EXPIRING_SOON_DAYS,
                        renewalHistoryAvailable: false,
                        pagination: false,
                    },
                },
            });
        } catch (error) {
            return sendError(
                res,
                error,
                "getCertificateRenewalAnalytics"
            );
        }
    };

// ============================================================
// CERTIFICATE ANALYTICS - API 3
// ============================================================
// GET /api/analytics/certificates/crew
//
// Returns:
// - Total crew
// - Crew with certificates
// - Crew without certificates
// - Crew with expiring certificates
// - Crew with expired certificates
// - Complete crew-wise certificate breakdown
//
// Crew scope: users.role_id = 4
// No pagination.
// ============================================================

export const getCrewCertificateAnalytics =
    async (req, res) => {
        try {
      await verifyAnalyticsRequest(req);
            // Use current user company and ship assignments
            const scope = roleScope(
                req,
                "u",
                { includeDates: false }
            );

            const where = `
        ${scope.where}
        AND u.role_id = 4
      `;

            const crewCte = `
        WITH crew AS (
          SELECT
            u.user_id,
            u.full_name,
            u.seafarer_id,
            u.rank,
            u.company_id,
            u.ship_id,

            co.company_name,
            sh.ship_name

          FROM public.users u

          LEFT JOIN public.company co
            ON co.company_id = u.company_id

          LEFT JOIN public.ships sh
            ON sh.ship_id = u.ship_id

          WHERE ${where}
        ),

        per_crew AS (
          SELECT
            crew.user_id,
            crew.full_name,
            crew.seafarer_id,
            crew.rank,
            crew.company_id,
            crew.ship_id,
            crew.company_name,
            crew.ship_name,

            COUNT(
              c.certificate_id
            )::int AS total_certificates,

            COUNT(c.certificate_id) FILTER (
              WHERE ${statusSql("c")} = 'active'
            )::int AS active,

            COUNT(c.certificate_id) FILTER (
              WHERE ${statusSql("c")} = 'expiring_soon'
            )::int AS expiring_soon,

            COUNT(c.certificate_id) FILTER (
              WHERE ${statusSql("c")} = 'expired'
            )::int AS expired,

            COUNT(c.certificate_id) FILTER (
              WHERE ${statusSql("c")} = 'revoked'
            )::int AS revoked,

            COUNT(c.certificate_id) FILTER (
              WHERE ${statusSql("c")}
                IN ('active', 'expiring_soon')
            )::int AS valid

          FROM crew

          LEFT JOIN public.certificates c
            ON c.user_id = crew.user_id
           AND (c.company_id = crew.company_id OR c.company_id IS NULL)

          GROUP BY
            crew.user_id,
            crew.full_name,
            crew.seafarer_id,
            crew.rank,
            crew.company_id,
            crew.ship_id,
            crew.company_name,
            crew.ship_name
        )
      `;

            // 1. Overall crew summary
            const summaryQuery = `
        ${crewCte}

        SELECT
          COUNT(*)::int AS total_crew,

          COUNT(*) FILTER (
            WHERE total_certificates > 0
          )::int AS crew_with_certificates,

          COUNT(*) FILTER (
            WHERE total_certificates = 0
          )::int AS crew_without_certificates,

          COUNT(*) FILTER (
            WHERE expiring_soon > 0
          )::int AS crew_with_expiring_certificates,

          COUNT(*) FILTER (
            WHERE expired > 0
          )::int AS crew_with_expired_certificates,

          COUNT(*) FILTER (
            WHERE revoked > 0
          )::int AS crew_with_revoked_certificates

        FROM per_crew
      `;

            // 2. All crew records
            const listQuery = `
        ${crewCte}

        SELECT
          *,

          CASE
            WHEN total_certificates = 0
              THEN 'no_certificates'

            WHEN expired > 0
              THEN 'expired_certificate'

            WHEN expiring_soon > 0
              THEN 'renewal_required'

            WHEN revoked > 0
              THEN 'revoked_certificate'

            ELSE 'valid_certificates'
          END AS certificate_health

        FROM per_crew

        ORDER BY
          full_name NULLS LAST,
          user_id
      `;

            const [summary, list] =
                await Promise.all([
                    db.query(
                        summaryQuery,
                        scope.params
                    ),

                    db.query(
                        listQuery,
                        scope.params
                    ),
                ]);

            return res.status(200).json({
                success: true,

                data: {
                    summary: summary.rows[0],

                    totalRecords: list.rows.length,

                    crew: list.rows,

                    definitions: {
                        population: "current_users_role_4",
                        shipGrouping: "current_user_ship",
                        certificateScope: "certificates_issued_to_current_company_or_global",
                        readinessCalculated: false,
                        pagination: false,
                    },
                },
            });
        } catch (error) {
            return sendError(
                res,
                error,
                "getCrewCertificateAnalytics"
            );
        }
    };

// ============================================================
// CERTIFICATE ANALYTICS - API 4
// ============================================================
// GET /api/analytics/certificates/compliance
//
// Returns:
// - Overall certificate validity
// - Ship-wise validity
// - Valid, active, expired and expiring certificates
//
// Mandatory requirement compliance is NOT calculated
// because certificate requirement rules are not available.
// ============================================================

export const getCertificateComplianceAnalytics =
    async (req, res) => {
        try {
      await verifyAnalyticsRequest(req);
            const scope = roleScope(req, "c");
            const cte = baseCte(scope);

            // 1. Overall certificate validity
            const summaryQuery = `
        ${cte}

        SELECT
          ${totalsSql("s")}

        FROM scoped s
      `;

            // 2. Ship-wise certificate validity
            const byShipQuery = `
        ${cte}

        SELECT
          s.ship_id,

          COALESCE(
            MAX(sh.ship_name),
            MAX(s.ship_name_snapshot),
            'Unassigned'
          ) AS ship_name,

          ${totalsSql("s")}

        FROM scoped s

        LEFT JOIN public.ships sh
          ON sh.ship_id = s.ship_id

        GROUP BY s.ship_id

        ORDER BY
          valid_percentage ASC NULLS LAST
      `;

            const [summary, ships] =
                await Promise.all([
                    db.query(
                        summaryQuery,
                        scope.params
                    ),

                    db.query(
                        byShipQuery,
                        scope.params
                    ),
                ]);

            return res.status(200).json({
                success: true,

                data: {
                    certificateValidity: {
                        summary: summary.rows[0],
                        byShip: ships.rows,
                    },

                    mandatoryCompliance: {
                        available: false,

                        totalRequired: null,
                        requirementsMet: null,
                        requirementsMissing: null,

                        compliancePercentage: null,

                        byCompany: null,
                        byShip: null,
                        byRank: null,

                        missingRequirements: null,

                        reason:
                            "Mandatory certificate rules by company, ship type and rank are not configured",
                    },

                    definitions: {
                        expiringSoonDays: EXPIRING_SOON_DAYS,
                        pagination: false,

                        notEquivalent:
                            "Certificate validity is not mandatory compliance",
                    },
                },
            });
        } catch (error) {
            return sendError(
                res,
                error,
                "getCertificateComplianceAnalytics"
            );
        }
    };


// Assessment analytics

export const getAssessmentOverviewAnalytics = async (req, res) => {
  try {
      await verifyAnalyticsRequest(req);
    const scope = buildAssessmentAnalyticsScope(req);
    const cte = assessmentAnalyticsCte(scope);

    const query = `
      ${cte}

      SELECT
        (
          SELECT COUNT(*)::int
          FROM scoped_assessments
        ) AS total_assessments,

        (
          SELECT COUNT(*)::int
          FROM scoped_assessments
          WHERE is_published = true
        ) AS published_assessments,

        (
          SELECT COUNT(*)::int
          FROM scoped_assessments
          WHERE is_published = false
        ) AS unpublished_assessments,

        COUNT(*)::int AS total_attempts,

        COUNT(DISTINCT aa.user_id)::int
          AS unique_participants,

        COUNT(*) FILTER (
          WHERE aa.status = 'in_progress'
        )::int AS in_progress_attempts,

        COUNT(*) FILTER (
          WHERE aa.status = 'submitted'
        )::int AS pending_evaluation,

        COUNT(*) FILTER (
          WHERE aa.status = 'evaluated'
        )::int AS evaluated_attempts,

        COUNT(*) FILTER (
          WHERE aa.status = 'expired'
        )::int AS expired_attempts,

        COUNT(*) FILTER (
          WHERE aa.status = 'evaluated'
            AND aa.is_passed IS TRUE
        )::int AS passed_attempts,

        COUNT(*) FILTER (
          WHERE aa.status = 'evaluated'
            AND aa.is_passed IS FALSE
        )::int AS failed_attempts,

        ROUND(
          AVG(aa.percentage) FILTER (
            WHERE aa.status = 'evaluated'
          ),
          2
        ) AS average_score_percentage,

        ROUND(
          100.0 * COUNT(*) FILTER (
            WHERE aa.status = 'evaluated'
              AND aa.is_passed IS TRUE
          ) / NULLIF(
            COUNT(*) FILTER (
              WHERE aa.status = 'evaluated'
                AND aa.is_passed IS NOT NULL
            ),
            0
          ),
          2
        ) AS overall_pass_rate

      FROM scoped_attempts aa
    `;

    const { rows } = await db.query(query, scope.params);

    return res.status(200).json({
      success: true,
      data: {
        summary: rows[0],
        definitions: {
          averageScoreUnit: "percentage",
          passRateDenominator: "evaluated_attempts_with_pass_result",
          totalAttempts: "all_attempt_statuses",
          assessmentCount: "non_deleted_assessments",
          reportingPeriodAppliesTo: "attempt_started_at",
          pagination: false,
        },
      },
    });
  } catch (error) {
    return assessmentAnalyticsSendError(
      res, error, "getAssessmentOverviewAnalytics"
    );
  }
};



export const getAssessmentPerformanceAnalytics = async (req, res) => {
  try {
      await verifyAnalyticsRequest(req);
    const scope = buildAssessmentAnalyticsScope(req);
    const cte = assessmentAnalyticsCte(scope);

    const query = `
      ${cte},

      attempt_stats AS (
        SELECT
          aa.assessment_id,

          COUNT(*)::int AS total_attempts,

          COUNT(DISTINCT aa.user_id)::int
            AS unique_participants,

          COUNT(*) FILTER (
            WHERE aa.status = 'evaluated'
          )::int AS evaluated_attempts,

          COUNT(*) FILTER (
            WHERE aa.status = 'submitted'
          )::int AS pending_evaluation,

          COUNT(*) FILTER (
            WHERE aa.status = 'evaluated'
              AND aa.is_passed IS TRUE
          )::int AS passed,

          COUNT(*) FILTER (
            WHERE aa.status = 'evaluated'
              AND aa.is_passed IS FALSE
          )::int AS failed,

          ROUND(
            AVG(aa.percentage) FILTER (
              WHERE aa.status = 'evaluated'
            ),
            2
          ) AS average_score,

          ROUND(
            MAX(aa.percentage) FILTER (
              WHERE aa.status = 'evaluated'
            ),
            2
          ) AS highest_score,

          ROUND(
            MIN(aa.percentage) FILTER (
              WHERE aa.status = 'evaluated'
            ),
            2
          ) AS lowest_score,

          ROUND(
            100.0 * COUNT(*) FILTER (
              WHERE aa.status = 'evaluated'
                AND aa.is_passed IS TRUE
            ) / NULLIF(
              COUNT(*) FILTER (
                WHERE aa.status = 'evaluated'
                  AND aa.is_passed IS NOT NULL
              ),
              0
            ),
            2
          ) AS pass_rate,

          COUNT(*) FILTER (
            WHERE aa.attempt_number = 1
              AND aa.status = 'evaluated'
          )::int AS evaluated_first_attempts,

          COUNT(*) FILTER (
            WHERE aa.attempt_number = 1
              AND aa.status = 'evaluated'
              AND aa.is_passed IS TRUE
          )::int AS passed_first_attempts,

          ROUND(
            100.0 * COUNT(*) FILTER (
              WHERE aa.attempt_number = 1
                AND aa.status = 'evaluated'
                AND aa.is_passed IS TRUE
            ) / NULLIF(
              COUNT(*) FILTER (
                WHERE aa.attempt_number = 1
                  AND aa.status = 'evaluated'
                  AND aa.is_passed IS NOT NULL
              ),
              0
            ),
            2
          ) AS first_attempt_pass_rate,

          ROUND(
            COUNT(*)::numeric /
              NULLIF(COUNT(DISTINCT aa.user_id), 0),
            2
          ) AS average_attempts_per_participant

        FROM scoped_attempts aa
        GROUP BY aa.assessment_id
      ),

      question_stats AS (
        SELECT
          q.assessment_id,
          COUNT(*)::int AS question_count
        FROM public.assessment_questions q
        JOIN scoped_assessments a
          ON a.assessment_id = q.assessment_id
        WHERE q.is_deleted = false
        GROUP BY q.assessment_id
      )

      SELECT
        a.assessment_id,
        a.title,
        a.assessment_type,
        a.category,
        a.difficulty_level,
        a.passing_percentage,
        a.total_marks,
        a.duration_minutes,
        a.is_published,
        a.company_id,
        a.ship_id,
        a.created_at,

        COALESCE(q.question_count, 0)
          AS question_count,

        COALESCE(s.total_attempts, 0)
          AS total_attempts,

        COALESCE(s.unique_participants, 0)
          AS unique_participants,

        COALESCE(s.evaluated_attempts, 0)
          AS evaluated_attempts,

        COALESCE(s.pending_evaluation, 0)
          AS pending_evaluation,

        COALESCE(s.passed, 0) AS passed,
        COALESCE(s.failed, 0) AS failed,

        s.average_score,
        s.highest_score,
        s.lowest_score,
        s.pass_rate,

        COALESCE(s.evaluated_first_attempts, 0)
          AS evaluated_first_attempts,

        COALESCE(s.passed_first_attempts, 0)
          AS passed_first_attempts,

        s.first_attempt_pass_rate,
        s.average_attempts_per_participant

      FROM scoped_assessments a

      LEFT JOIN attempt_stats s
        ON s.assessment_id = a.assessment_id

      LEFT JOIN question_stats q
        ON q.assessment_id = a.assessment_id

      ORDER BY
        total_attempts DESC,
        a.title ASC
    `;

    const { rows } = await db.query(query, scope.params);

    return res.status(200).json({
      success: true,
      data: {
        totalAssessments: rows.length,
        assessmentBreakdown: rows,
        performanceRegister: rows,
        definitions: {
          scoreUnit: "percentage",
          firstAttempt: "attempt_number_1",
          passRateDenominator: "evaluated_with_pass_result",
          averageAttemptsPopulation: "all_started_attempts_per_participant",
          includesZeroAttemptAssessments: true,
          reportingPeriodAppliesTo: "attempt_started_at",
          pagination: false,
        },
      },
    });
  } catch (error) {
    return assessmentAnalyticsSendError(
      res, error, "getAssessmentPerformanceAnalytics"
    );
  }
};



export const getAssessmentAssignmentAnalytics = async (req, res) => {
  try {
      await verifyAnalyticsRequest(req);
    const scope = buildAssessmentAnalyticsScope(req);

    // =====================================================
    // SHARED ASSIGNMENT DATASET
    // =====================================================

    const cte = `
      WITH scoped_assessments AS (
        SELECT a.*
        FROM public.assessments a
        WHERE ${scope.aWhere}
      ),

      assignment_records AS (
        SELECT
          asg.assignment_id,
          asg.assessment_id,
          asg.user_id,
          asg.company_id,
          asg.ship_id,
          asg.assigned_by,
          asg.created_at AS assigned_at,
          asg.due_date,

          a.title AS assessment_title,
          a.assessment_type,
          a.category,
          a.difficulty_level,
          a.passing_percentage,

          u.full_name,
          u.seafarer_id,
          u.rank,

          co.company_name,
          sh.ship_name,

          COALESCE(
            linked.course_id,
            a.training_id
          ) AS linked_training_id,

          cr.title AS linked_training_title,

          latest.attempt_id,
          latest.status AS attempt_status,
          latest.is_passed,
          latest.percentage,
          latest.attempt_number,
          latest.started_at,
          latest.submitted_at,

          CASE
            WHEN latest.status = 'evaluated'
              AND latest.is_passed IS TRUE
              THEN 'completed'

            WHEN asg.due_date IS NOT NULL
              AND asg.due_date < NOW()
              THEN 'overdue'

            WHEN latest.status = 'submitted'
              THEN 'pending_evaluation'

            WHEN latest.status = 'evaluated'
              AND latest.is_passed IS FALSE
              THEN 'failed'

            WHEN latest.status = 'in_progress'
              THEN 'in_progress'

            ELSE 'assigned'
          END AS assignment_status

        FROM public.assessment_assignments asg

        JOIN scoped_assessments a
          ON a.assessment_id = asg.assessment_id

        JOIN public.users u
          ON u.user_id = asg.user_id

        LEFT JOIN public.company co
          ON co.company_id = asg.company_id

        LEFT JOIN public.ships sh
          ON sh.ship_id = asg.ship_id

        LEFT JOIN LATERAL (
          SELECT ca.course_id
          FROM public.course_assessments ca
          WHERE ca.assessment_id = a.assessment_id
          ORDER BY ca.course_id
          LIMIT 1
        ) linked ON TRUE

        LEFT JOIN public.courses cr
          ON cr.id = COALESCE(
            linked.course_id,
            a.training_id
          )

        LEFT JOIN LATERAL (
          SELECT
            aa.attempt_id,
            aa.status,
            aa.is_passed,
            aa.percentage,
            aa.attempt_number,
            aa.started_at,
            aa.submitted_at

          FROM public.assessment_attempts aa

          WHERE aa.assessment_id = asg.assessment_id
            AND aa.user_id = asg.user_id

          ORDER BY
            aa.created_at DESC,
            aa.attempt_id DESC

          LIMIT 1
        ) latest ON TRUE

        WHERE ${scope.assignmentWhere}
          AND ${scope.uWhere}
          AND ${scope.assignmentPeriod}
      )
    `;

    // =====================================================
    // QUERY 1 - OVERALL ASSIGNMENT SUMMARY
    // =====================================================

    const summaryQuery = `
      ${cte}

      SELECT
        COUNT(*)::int AS total_assignments,

        COUNT(DISTINCT assessment_id)::int
          AS assigned_assessments,

        COUNT(DISTINCT user_id)::int
          AS assigned_users,

        COUNT(DISTINCT ship_id)::int
          AS assigned_ships,

        COUNT(DISTINCT (assessment_id, ship_id))
          FILTER (
            WHERE ship_id IS NOT NULL
          )::int AS assessment_ship_combinations,

        COUNT(*) FILTER (
          WHERE assignment_status = 'assigned'
        )::int AS assigned,

        COUNT(*) FILTER (
          WHERE assignment_status = 'in_progress'
        )::int AS in_progress,

        COUNT(*) FILTER (
          WHERE assignment_status = 'completed'
        )::int AS completed,

        COUNT(*) FILTER (
          WHERE assignment_status = 'failed'
        )::int AS failed,

        COUNT(*) FILTER (
          WHERE assignment_status = 'overdue'
        )::int AS overdue,

        COUNT(*) FILTER (
          WHERE assignment_status = 'pending_evaluation'
        )::int AS pending_evaluation,

        ROUND(
          100.0 * COUNT(*) FILTER (
            WHERE assignment_status = 'completed'
          ) / NULLIF(COUNT(*), 0),
          2
        ) AS completion_rate

      FROM assignment_records
    `;

    // =====================================================
    // QUERY 2 - VESSEL-WISE ASSESSMENT MATRIX
    // =====================================================

    const matrixQuery = `
      ${cte}

      SELECT
        assessment_id,
        assessment_title,
        assessment_type,
        category,

        company_id,
        company_name,
        ship_id,
        ship_name,

        MAX(linked_training_id)
          AS linked_training_id,

        MAX(linked_training_title)
          AS linked_training_title,

        MIN(assigned_at) AS first_assigned_at,
        MAX(assigned_at) AS last_assigned_at,

        MIN(due_date) AS earliest_due_date,
        MAX(due_date) AS latest_due_date,

        COUNT(*)::int AS assigned_crew,

        COUNT(*) FILTER (
          WHERE assignment_status = 'completed'
        )::int AS completed_crew,

        COUNT(*) FILTER (
          WHERE assignment_status = 'in_progress'
        )::int AS in_progress_crew,

        COUNT(*) FILTER (
          WHERE assignment_status = 'assigned'
        )::int AS not_started_crew,

        COUNT(*) FILTER (
          WHERE assignment_status = 'failed'
        )::int AS failed_crew,

        COUNT(*) FILTER (
          WHERE assignment_status = 'overdue'
        )::int AS overdue_crew,

        COUNT(*) FILTER (
          WHERE assignment_status = 'pending_evaluation'
        )::int AS pending_evaluation_crew,

        ROUND(
          100.0 * COUNT(*) FILTER (
            WHERE assignment_status = 'completed'
          ) / NULLIF(COUNT(*), 0),
          2
        ) AS completion_percentage,

        CASE
          WHEN COUNT(*) FILTER (
            WHERE assignment_status = 'overdue'
          ) > 0
            THEN 'overdue'

          WHEN COUNT(*) FILTER (
            WHERE assignment_status = 'completed'
          ) = COUNT(*)
            THEN 'completed'

          WHEN COUNT(*) FILTER (
            WHERE assignment_status IN (
              'in_progress',
              'completed',
              'failed',
              'pending_evaluation'
            )
          ) > 0
            THEN 'in_progress'

          ELSE 'assigned'
        END AS ship_assignment_status

      FROM assignment_records

      GROUP BY
        assessment_id,
        assessment_title,
        assessment_type,
        category,
        company_id,
        company_name,
        ship_id,
        ship_name

      ORDER BY
        company_name,
        ship_name,
        assessment_title
    `;

    // =====================================================
    // QUERY 3 - COMPLETE ASSIGNMENT REGISTER
    // =====================================================

    const registerQuery = `
      ${cte}

      SELECT
        assignment_id,
        assessment_id,
        assessment_title,
        assessment_type,
        category,

        user_id,
        full_name,
        seafarer_id,
        rank,

        company_id,
        company_name,
        ship_id,
        ship_name,

        linked_training_id,
        linked_training_title,

        assigned_by,
        assigned_at,
        due_date,

        attempt_id,
        attempt_status,
        attempt_number,
        percentage,
        is_passed,
        started_at,
        submitted_at,

        assignment_status

      FROM assignment_records

      ORDER BY
        assigned_at DESC,
        company_name,
        ship_name,
        full_name
    `;

    // =====================================================
    // EXECUTE ALL THREE QUERIES
    // =====================================================

    const [summary, matrix, register] =
      await Promise.all([
        db.query(summaryQuery, scope.params),
        db.query(matrixQuery, scope.params),
        db.query(registerQuery, scope.params),
      ]);

    // =====================================================
    // RESPONSE
    // =====================================================

    return res.status(200).json({
      success: true,

      data: {
        summary: summary.rows[0],

        totalMatrixRecords: matrix.rows.length,
        vesselAssignmentMatrix: matrix.rows,

        totalAssignmentRecords: register.rows.length,
        assignmentRegister: register.rows,

        definitions: {
          assignmentSource:
            "assessment_assignments",

          grouping:
            "assessment_company_ship",

          assignmentStatus:
            "derived_from_latest_attempt_and_due_date",

          completed:
            "latest_attempt_evaluated_and_passed",

          assignedShipCount:
            "distinct_ships_with_assignment_records",

          linkedTraining:
            "course_assessments_or_assessments_training_id",

          reportingPeriodAppliesTo:
            "assignment_created_at",

          pagination: false,
        },
      },
    });
  } catch (error) {
    return assessmentAnalyticsSendError(
      res,
      error,
      "getAssessmentAssignmentAnalytics"
    );
  }
};


//training analytics

export const getTrainingOverviewAnalytics = async (req, res) => {
  try {
      await verifyAnalyticsRequest(req);
    const scope = buildTrainingAnalyticsScope(req);
    const cte = trainingAnalyticsCte(scope);

    // =====================================================
    // QUERY 1: TRAINING OVERVIEW
    // =====================================================

    const summaryQuery = `
      ${cte}

      SELECT
        (
          SELECT COUNT(*)::int
          FROM scoped_courses
        ) AS total_programmes,

        (
          SELECT COUNT(*)::int
          FROM scoped_courses
          WHERE status = 'published'
        ) AS published_programmes,

        (
          SELECT COUNT(*)::int
          FROM scoped_courses
          WHERE status = 'draft'
        ) AS draft_programmes,

        (
          SELECT COUNT(*)::int
          FROM scoped_courses
          WHERE status = 'archived'
        ) AS archived_programmes,

        COUNT(*)::int AS total_enrolments,

        COUNT(DISTINCT e.user_id)::int
          AS unique_learners,

        COUNT(*) FILTER (
          WHERE e.assigned = true
        )::int AS assigned_enrolments,

        COUNT(*) FILTER (
          WHERE e.assigned = false
        )::int AS unassigned_enrolments,

        COUNT(*) FILTER (
          WHERE e.learning_status = 'completed'
        )::int AS completed_enrolments,

        COUNT(*) FILTER (
          WHERE e.learning_status = 'in_progress'
        )::int AS in_progress_enrolments,

        COUNT(*) FILTER (
          WHERE e.learning_status = 'not_started'
        )::int AS not_started_enrolments,

        COUNT(*) FILTER (
          WHERE e.learning_status = 'cancelled'
        )::int AS cancelled_enrolments,

        COUNT(*) FILTER (
          WHERE e.certificate_issued = true
        )::int AS certificate_issued_enrolments,

        ROUND(
          100.0 * COUNT(*) FILTER (
            WHERE e.learning_status = 'completed'
          ) / NULLIF(
            COUNT(*) FILTER (
              WHERE e.learning_status <> 'cancelled'
            ),
            0
          ),
          2
        ) AS completion_rate,

        ROUND(
          AVG(
            EXTRACT(
              EPOCH FROM (
                e.completed_at - e.enrolled_at
              )
            ) / 3600
          ) FILTER (
            WHERE e.learning_status = 'completed'
              AND e.completed_at >= e.enrolled_at
          )::numeric,
          2
        ) AS average_elapsed_completion_hours

      FROM scoped_enrollments e
    `;

    // =====================================================
    // QUERY 2: TRAINING LIFECYCLE
    // =====================================================

    const lifecycleQuery = `
      ${cte}

      SELECT
        COUNT(*) FILTER (
          WHERE e.assigned = true
        )::int AS assigned,

        COUNT(*) FILTER (
          WHERE e.learning_status <> 'cancelled'
        )::int AS enrolled_active,

        COUNT(*) FILTER (
          WHERE e.learning_status = 'in_progress'
        )::int AS in_progress,

        COUNT(*) FILTER (
          WHERE e.learning_status = 'completed'
        )::int AS completed,

        COUNT(*) FILTER (
          WHERE e.learning_status = 'not_started'
        )::int AS not_started,

        COUNT(*) FILTER (
          WHERE e.learning_status = 'cancelled'
        )::int AS cancelled,

        ROUND(
          100.0 * COUNT(*) FILTER (
            WHERE e.learning_status = 'completed'
              AND e.assigned = true
          ) / NULLIF(
            COUNT(*) FILTER (
              WHERE e.assigned = true
                AND e.learning_status <> 'cancelled'
            ),
            0
          ),
          2
        ) AS assigned_completion_rate

      FROM scoped_enrollments e
    `;

    // =====================================================
    // QUERY 3: MONTHLY COMPLETION TREND
    // =====================================================

    // Completion event trend: filter by completed_at, not enrolled_at.
    const trendsQuery = `
      ${cte}
      SELECT
        TO_CHAR(DATE_TRUNC('month', ce.completed_at), 'YYYY-MM') AS month,
        COUNT(*)::int AS completions,
        COUNT(DISTINCT ce.user_id)::int AS unique_learners
      FROM public.course_enrollments ce
      JOIN scoped_courses c ON c.id = ce.course_id
      JOIN public.users u ON u.user_id = ce.user_id
      WHERE ${scope.enrollmentWhereNoDate}
        AND ce.status <> 'cancelled'
        AND ce.completion_status = 'completed'
        AND ce.completed_at IS NOT NULL
        ${scope.dateFromParam ? `AND ce.completed_at >= ${scope.dateFromParam}::date` : ''}
        ${scope.dateToParam ? `AND ce.completed_at < (${scope.dateToParam}::date + INTERVAL '1 day')` : ''}
      GROUP BY DATE_TRUNC('month', ce.completed_at)
      ORDER BY DATE_TRUNC('month', ce.completed_at)
    `;

    const [summary, lifecycle, trends] =
      await Promise.all([
        db.query(summaryQuery, scope.params),
        db.query(lifecycleQuery, scope.params),
        db.query(trendsQuery, scope.params),
      ]);

    return res.status(200).json({
      success: true,
      data: {
        summary: {
          ...summary.rows[0],

          // Not tracked by the provided schema
          learning_hours: null,
          average_learning_duration: null,
        },

        lifecycle: {
          ...lifecycle.rows[0],

          // No verified learning-start event exists
          started: null,
          abandonment_rate: null,
        },

        monthlyCompletions: trends.rows,

        definitions: {
          programmeSource: "courses",
          enrollmentSource: "course_enrollments",
          completionField: "completion_status",
          completedValue: "completed",
          reportingPeriod: "enrolled_at_for_cohort_metrics_completed_at_for_monthly_trend",
          elapsedCompletionHours:
            "time_between_enrollment_and_completion_not_learning_time",
          learningHoursAvailable: false,
          startedStageAvailable: false,
          pagination: false,
        },
      },
    });
  } catch (error) {
    return trainingAnalyticsSendError(
      res,
      error,
      "getTrainingOverviewAnalytics"
    );
  }
};



export const getTrainingPerformanceAnalytics = async (req, res) => {
  try {
      await verifyAnalyticsRequest(req);
    const scope = buildTrainingAnalyticsScope(req);
    const cte = trainingAnalyticsCte(scope);

    // =====================================================
    // SHARED PROGRAMME-LEVEL AGGREGATION
    // =====================================================

    const programmeCte = `
      ${cte},

      enrollment_stats AS (
        SELECT
          e.course_id,

          COUNT(*)::int AS total_enrolments,

          COUNT(DISTINCT e.user_id)::int
            AS unique_learners,

          COUNT(*) FILTER (
            WHERE e.assigned = true
          )::int AS assigned_learners,

          COUNT(*) FILTER (
            WHERE e.learning_status = 'completed'
          )::int AS completed,

          COUNT(*) FILTER (
            WHERE e.learning_status = 'in_progress'
          )::int AS in_progress,

          COUNT(*) FILTER (
            WHERE e.learning_status = 'not_started'
          )::int AS not_started,

          COUNT(*) FILTER (
            WHERE e.learning_status = 'cancelled'
          )::int AS cancelled,

          ROUND(
            100.0 * COUNT(*) FILTER (
              WHERE e.learning_status = 'completed'
            ) / NULLIF(
              COUNT(*) FILTER (
                WHERE e.learning_status <> 'cancelled'
              ),
              0
            ),
            2
          ) AS completion_rate,

          ROUND(
            AVG(
              EXTRACT(
                EPOCH FROM (
                  e.completed_at - e.enrolled_at
                )
              ) / 3600
            ) FILTER (
              WHERE e.learning_status = 'completed'
                AND e.completed_at >= e.enrolled_at
            )::numeric,
            2
          ) AS average_elapsed_completion_hours

        FROM scoped_enrollments e
        GROUP BY e.course_id
      ),

      content_stats AS (
        SELECT
          cc.course_id,
          COUNT(*)::int AS content_count,

          COUNT(*) FILTER (
            WHERE cc.content_type = 'youtube'
          )::int AS youtube_count,

          COUNT(*) FILTER (
            WHERE cc.content_type = 'video_file'
          )::int AS video_count,

          COUNT(*) FILTER (
            WHERE cc.content_type = 'document'
          )::int AS document_count,

          COUNT(*) FILTER (
            WHERE cc.content_type = 'ppt'
          )::int AS ppt_count,

          COUNT(*) FILTER (
            WHERE cc.content_type = 'image'
          )::int AS image_count

        FROM public.course_contents cc

        JOIN scoped_courses c
          ON c.id = cc.course_id

        GROUP BY cc.course_id
      ),

      programme_stats AS (
        SELECT
          c.id AS course_id,
          c.title AS programme_name,
          c.department AS category,
          c.content_mode AS format,
          c.status AS programme_status,
          c.company_id,
          c.ship_id,
          c.ranks,
          c.ship_types,
          c.created_at,

          COALESCE(s.total_enrolments, 0)
            AS total_enrolments,

          COALESCE(s.unique_learners, 0)
            AS unique_learners,

          COALESCE(s.assigned_learners, 0)
            AS assigned_learners,

          COALESCE(s.completed, 0)
            AS completed,

          COALESCE(s.in_progress, 0)
            AS in_progress,

          COALESCE(s.not_started, 0)
            AS not_started,

          COALESCE(s.cancelled, 0)
            AS cancelled,

          s.completion_rate,
          s.average_elapsed_completion_hours,

          COALESCE(cs.content_count, 0)
            AS content_count,

          COALESCE(cs.youtube_count, 0)
            AS youtube_count,

          COALESCE(cs.video_count, 0)
            AS video_count,

          COALESCE(cs.document_count, 0)
            AS document_count,

          COALESCE(cs.ppt_count, 0)
            AS ppt_count,

          COALESCE(cs.image_count, 0)
            AS image_count

        FROM scoped_courses c

        LEFT JOIN enrollment_stats s
          ON s.course_id = c.id

        LEFT JOIN content_stats cs
          ON cs.course_id = c.id
      )
    `;

    // =====================================================
    // QUERY 1: COMPLETE PROGRAMME PERFORMANCE REGISTER
    // =====================================================

    const programmeQuery = `
      ${programmeCte}

      SELECT *
      FROM programme_stats

      ORDER BY
        total_enrolments DESC,
        programme_name
    `;

    // =====================================================
    // QUERY 2: CATEGORY BREAKDOWN
    // =====================================================

    const categoryQuery = `
      ${programmeCte}

      SELECT
        COALESCE(category, 'Uncategorised')
          AS category,

        COUNT(*)::int AS programmes,

        SUM(total_enrolments)::int
          AS enrolments,

        SUM(assigned_learners)::int
          AS assigned_learners,

        SUM(completed)::int AS completed,

        ROUND(
          100.0 * SUM(completed) /
          NULLIF(
            SUM(
              total_enrolments - cancelled
            ),
            0
          ),
          2
        ) AS completion_rate

      FROM programme_stats

      GROUP BY category

      ORDER BY enrolments DESC
    `;

    // =====================================================
    // QUERY 3: TRAINING FORMAT BREAKDOWN
    // =====================================================

    const formatQuery = `
      ${programmeCte}

      SELECT
        format,

        COUNT(*)::int AS programmes,

        SUM(total_enrolments)::int
          AS enrolments,

        SUM(completed)::int AS completed,

        ROUND(
          100.0 * SUM(completed) /
          NULLIF(
            SUM(total_enrolments - cancelled),
            0
          ),
          2
        ) AS completion_rate

      FROM programme_stats

      GROUP BY format

      ORDER BY programmes DESC
    `;

    const [programmes, categories, formats] =
      await Promise.all([
        db.query(programmeQuery, scope.params),
        db.query(categoryQuery, scope.params),
        db.query(formatQuery, scope.params),
      ]);

    return res.status(200).json({
      success: true,
      data: {
        totalProgrammes: programmes.rows.length,

        programmeRegister: programmes.rows,

        categoryBreakdown: categories.rows,

        formatBreakdown: formats.rows,

        definitions: {
          categorySource: "courses.department",
          formatSource: "courses.content_mode",
          mediaTypeSource: "course_contents.content_type",
          popularityMetric: "total_enrolments",
          completionTime:
            "elapsed_enrollment_to_completion_not_actual_study_duration",
          includesZeroEnrollmentProgrammes: true,
          pagination: false,
        },
      },
    });
  } catch (error) {
    return trainingAnalyticsSendError(
      res,
      error,
      "getTrainingPerformanceAnalytics"
    );
  }
};



export const getTrainingAssignmentAnalytics = async (req, res) => {
  try {
      await verifyAnalyticsRequest(req);
    const scope = buildTrainingAnalyticsScope(req);
    const cte = trainingAnalyticsCte(scope);

    // =====================================================
    // SHARED ASSIGNMENT DATASET
    // =====================================================

    const assignmentCte = `
      ${cte},

      assignment_records AS (
        SELECT
          e.enrollment_id,
          e.course_id,
          c.title AS programme_name,
          c.department AS category,
          c.content_mode AS format,

          e.user_id,
          e.full_name,
          e.seafarer_id,
          e.rank,

          e.user_company_id AS company_id,
          e.company_name,

          e.user_ship_id AS ship_id,
          e.ship_name,

          e.enrolled_by AS assigned_by,

          e.enrolled_at AS assignment_date_proxy,

          e.enrolled_at AS recorded_enrollment_at,
          e.completed_at,

          e.learning_status,
          e.certificate_issued,

          CASE
            WHEN e.learning_status = 'completed'
              THEN 'completed'

            WHEN e.learning_status = 'cancelled'
              THEN 'cancelled'

            WHEN e.learning_status = 'in_progress'
              THEN 'in_progress'

            ELSE 'not_started'
          END AS assignment_status

        FROM scoped_enrollments e

        JOIN scoped_courses c
          ON c.id = e.course_id

        WHERE e.assigned = true
      )
    `;

    // =====================================================
    // QUERY 1: OVERALL ASSIGNMENT SUMMARY
    // =====================================================

    const summaryQuery = `
      ${assignmentCte}

      SELECT
        COUNT(*)::int AS total_assignments,

        COUNT(DISTINCT course_id)::int
          AS assigned_programmes,

        COUNT(DISTINCT user_id)::int
          AS assigned_crew,

        COUNT(DISTINCT ship_id)::int
          AS assigned_ships,

        COUNT(DISTINCT (course_id, ship_id))
          FILTER (
            WHERE ship_id IS NOT NULL
          )::int AS programme_ship_combinations,

        COUNT(*) FILTER (
          WHERE assignment_status = 'completed'
        )::int AS completed,

        COUNT(*) FILTER (
          WHERE assignment_status = 'in_progress'
        )::int AS in_progress,

        COUNT(*) FILTER (
          WHERE assignment_status = 'not_started'
        )::int AS not_started,

        COUNT(*) FILTER (
          WHERE assignment_status = 'cancelled'
        )::int AS cancelled,

        COUNT(*) FILTER (
          WHERE assignment_status <> 'completed'
            AND assignment_status <> 'cancelled'
        )::int AS pending,

        ROUND(
          100.0 * COUNT(*) FILTER (
            WHERE assignment_status = 'completed'
          ) / NULLIF(
            COUNT(*) FILTER (
              WHERE assignment_status <> 'cancelled'
            ),
            0
          ),
          2
        ) AS completion_rate

      FROM assignment_records
    `;

    // =====================================================
    // QUERY 2: SHIP-WISE TRAINING ASSIGNMENTS
    // =====================================================

    const shipQuery = `
      ${assignmentCte}

      SELECT
        company_id,
        company_name,
        ship_id,
        ship_name,

        course_id,
        programme_name,
        category,
        format,

        MIN(assignment_date_proxy)
          AS first_recorded_enrollment_at,

        MAX(assignment_date_proxy)
          AS latest_recorded_enrollment_at,

        COUNT(*)::int AS assigned_crew,

        COUNT(*) FILTER (
          WHERE assignment_status = 'completed'
        )::int AS completed_crew,

        COUNT(*) FILTER (
          WHERE assignment_status = 'in_progress'
        )::int AS in_progress_crew,

        COUNT(*) FILTER (
          WHERE assignment_status = 'not_started'
        )::int AS not_started_crew,

        COUNT(*) FILTER (
          WHERE assignment_status = 'cancelled'
        )::int AS cancelled_crew,

        COUNT(*) FILTER (
          WHERE assignment_status NOT IN (
            'completed',
            'cancelled'
          )
        )::int AS pending_crew,

        ROUND(
          100.0 * COUNT(*) FILTER (
            WHERE assignment_status = 'completed'
          ) / NULLIF(
            COUNT(*) FILTER (
              WHERE assignment_status <> 'cancelled'
            ),
            0
          ),
          2
        ) AS completion_rate,

        CASE
          WHEN COUNT(*) FILTER (
            WHERE assignment_status = 'completed'
          ) = COUNT(*)
            THEN 'completed'

          WHEN COUNT(*) FILTER (
            WHERE assignment_status IN (
              'completed',
              'in_progress'
            )
          ) > 0
            THEN 'in_progress'

          ELSE 'assigned'
        END AS assignment_status

      FROM assignment_records

      GROUP BY
        company_id,
        company_name,
        ship_id,
        ship_name,
        course_id,
        programme_name,
        category,
        format

      ORDER BY
        company_name,
        ship_name,
        programme_name
    `;

    // =====================================================
    // QUERY 3: PROGRAMME-WISE ASSIGNMENT SUMMARY
    // =====================================================

    const programmeQuery = `
      ${assignmentCte}

      SELECT
        course_id,
        programme_name,
        category,
        format,

        COUNT(*)::int AS assigned_crew,

        COUNT(DISTINCT ship_id)::int
          AS assigned_ships,

        COUNT(DISTINCT company_id)::int
          AS assigned_companies,

        COUNT(*) FILTER (
          WHERE assignment_status = 'completed'
        )::int AS completed_crew,

        COUNT(*) FILTER (
          WHERE assignment_status = 'in_progress'
        )::int AS in_progress_crew,

        COUNT(*) FILTER (
          WHERE assignment_status = 'not_started'
        )::int AS not_started_crew,

        COUNT(*) FILTER (
          WHERE assignment_status <> 'completed'
            AND assignment_status <> 'cancelled'
        )::int AS pending_crew,

        ROUND(
          100.0 * COUNT(*) FILTER (
            WHERE assignment_status = 'completed'
          ) / NULLIF(
            COUNT(*) FILTER (
              WHERE assignment_status <> 'cancelled'
            ),
            0
          ),
          2
        ) AS completion_rate

      FROM assignment_records

      GROUP BY
        course_id,
        programme_name,
        category,
        format

      ORDER BY assigned_crew DESC
    `;

    // =====================================================
    // QUERY 4: COMPLETE ASSIGNMENT REGISTER
    // =====================================================

    const registerQuery = `
      ${assignmentCte}

      SELECT
        enrollment_id,
        course_id,
        programme_name,
        category,
        format,

        user_id,
        full_name,
        seafarer_id,
        rank,

        company_id,
        company_name,
        ship_id,
        ship_name,

        assigned_by,
        assignment_date_proxy,
        recorded_enrollment_at,
        completed_at,

        learning_status,
        assignment_status,
        certificate_issued

      FROM assignment_records

      ORDER BY
        recorded_enrollment_at DESC,
        company_name,
        ship_name,
        full_name
    `;

    // =====================================================
    // EXECUTE ALL QUERIES
    // =====================================================

    const [
      summary,
      ships,
      programmes,
      register,
    ] = await Promise.all([
      db.query(summaryQuery, scope.params),
      db.query(shipQuery, scope.params),
      db.query(programmeQuery, scope.params),
      db.query(registerQuery, scope.params),
    ]);

    return res.status(200).json({
      success: true,

      data: {
        summary: summary.rows[0],

        shipWiseAssignments: ships.rows,

        programmeWiseAssignments: programmes.rows,

        totalAssignmentRecords: register.rows.length,

        assignmentRegister: register.rows,

        definitions: {
          assignmentSource: "course_enrollments",
          assignmentFilter: "assigned_true",

          shipGrouping: "current_user_ship",
          companyGrouping: "current_user_company",

          assignmentDate:
            "enrolled_at_proxy_not_verified_assignment_timestamp",

          mandatoryOptionalAvailable: false,
          mandatoryOptionalReason:
            "No assignment-level mandatory/optional field exists",

          pagination: false,
        },
      },
    });
  } catch (error) {
    return trainingAnalyticsSendError(
      res,
      error,
      "getTrainingAssignmentAnalytics"
    );
  }
};


//executive , vessels, companies, crew


export const getExecutiveCombinedAnalytics = async (req, res) => {
  try {
      await verifyAnalyticsRequest(req);
    const scope = fmiScope(req);

    // =====================================================
    // EXECUTIVE KPI OVERVIEW
    // =====================================================

    const overviewQ = `
      ${fmiCombinedCte}

      SELECT
        (
          SELECT COUNT(*)::int
          FROM fmi_companies
        ) AS total_companies,

        (
          SELECT COUNT(*)::int
          FROM fmi_companies
          WHERE is_active
        ) AS active_companies,

        (
          SELECT COUNT(*)::int
          FROM fmi_ships
        ) AS total_vessels,

        TO_CHAR(
          CURRENT_DATE,
          'YYYY-MM'
        ) AS as_of_month,

        ${fmiRollupSql("p")},

        COUNT(p.user_id) FILTER (
          WHERE p.training_eligible > 0
        )::int AS enrolled_learners

      FROM fmi_per_crew p
    `;

    // =====================================================
    // MONTHLY TRAINING AND ASSESSMENT TRENDS
    // =====================================================
    // Training uses completion date.
    // Assessment uses submitted/start date.
    // Competency and mandatory compliance remain unavailable.

    const trendQ = `
      ${fmiCombinedCte},

      monthly_events AS (
        SELECT
          DATE_TRUNC(
            'month',
            ce.completed_at
          )::date AS month,

          COUNT(*)::int AS training_completions,

          0::int AS evaluated_assessments,
          0::int AS passed_assessments

        FROM public.course_enrollments ce

        JOIN fmi_crew u
          ON u.user_id = ce.user_id

        JOIN public.courses cr
          ON cr.id = ce.course_id
          AND cr.deleted_at IS NULL

        CROSS JOIN fmi_filter f

        WHERE (
          cr.company_id IS NULL
          OR cr.company_id = u.company_id
        )

          AND ce.status <> 'cancelled'

          AND ce.completion_status = 'completed'

          AND ce.completed_at IS NOT NULL

          AND (
            f.date_from IS NULL
            OR ce.completed_at >= f.date_from
          )

          AND (
            f.date_to IS NULL
            OR ce.completed_at <
              f.date_to + INTERVAL '1 day'
          )

        GROUP BY 1

        UNION ALL

        SELECT
          DATE_TRUNC(
            'month',
            COALESCE(
              aa.submitted_at,
              aa.started_at
            )
          )::date,

          0::int,

          COUNT(*)::int,

          COUNT(*) FILTER (
            WHERE aa.is_passed IS TRUE
          )::int

        FROM public.assessment_attempts aa

        JOIN fmi_crew u
          ON u.user_id = aa.user_id

        JOIN public.assessments a
          ON a.assessment_id = aa.assessment_id
          AND a.is_deleted = false

        CROSS JOIN fmi_filter f

        WHERE (
          a.company_id IS NULL
          OR a.company_id = u.company_id
        )

          AND aa.status = 'evaluated'

          AND aa.is_passed IS NOT NULL

          AND (
            f.date_from IS NULL
            OR COALESCE(
              aa.submitted_at,
              aa.started_at
            ) >= f.date_from
          )

          AND (
            f.date_to IS NULL
            OR COALESCE(
              aa.submitted_at,
              aa.started_at
            ) < f.date_to + INTERVAL '1 day'
          )

        GROUP BY 1
      )

      SELECT
        TO_CHAR(
          month,
          'YYYY-MM'
        ) AS month,

        SUM(training_completions)::int
          AS training_completions,

        SUM(evaluated_assessments)::int
          AS evaluated_assessments,

        SUM(passed_assessments)::int
          AS passed_assessments,

        ROUND(
          100.0 * SUM(passed_assessments)
          / NULLIF(
            SUM(evaluated_assessments),
            0
          ),
          2
        )::float8 AS assessment_pass_rate,

        NULL::float8 AS competency_score,

        NULL::float8 AS mandatory_compliance_rate

      FROM monthly_events

      GROUP BY month

      ORDER BY month
    `;


    const gapsQ = `
      ${fmiCombinedCte}
      SELECT
        d.domain AS category,
        SUM(d.assigned)::int AS total_assigned,
        SUM(d.completed)::int AS total_completed,
        GREATEST(SUM(d.assigned) - SUM(d.completed), 0)::int AS outstanding,
        ROUND(100.0 * SUM(d.completed) / NULLIF(SUM(d.assigned), 0), 2)::float8
          AS category_completion_rate
      FROM fmi_crew u
      JOIN public.user_competency_matrix m ON m.user_id = u.user_id
      CROSS JOIN LATERAL (VALUES
        ${fmiMatrixDomainValuesSql("m")}
      ) AS d(domain, assigned, completed)
      GROUP BY d.domain
      ORDER BY outstanding DESC, category_completion_rate ASC NULLS LAST, d.domain
    `;

    const [overview, trends, gaps] = await Promise.all([
      db.query(overviewQ, scope.params),
      db.query(trendQ, scope.params),
      db.query(gapsQ, scope.params),
    ]);

    const months = trends.rows;

    const {
      as_of_month: currentMonth,
      ...kpis
    } = overview.rows[0];

    const [year, month] =
      currentMonth.split("-").map(Number);

    const previousMonth = new Date(
      Date.UTC(year, month - 2, 1)
    ).toISOString().slice(0, 7);

    const monthDefaults = (m) => ({
      month: m,
      training_completions: 0,
      evaluated_assessments: 0,
      passed_assessments: 0,
      assessment_pass_rate: null,
      competency_score: null,
      mandatory_compliance_rate: null,
    });

    const current =
      months.find((x) => x.month === currentMonth) ||
      monthDefaults(currentMonth);

    const previous =
      months.find((x) => x.month === previousMonth) ||
      monthDefaults(previousMonth);

    const comparisonAvailable =
      !scope.filters.dateFrom &&
      !scope.filters.dateTo;

    return res.status(200).json({
      success: true,

      data: {
        kpis: {
          ...kpis,

          active_learners: null,
          competency_score: null,
          mandatory_compliance_percentage: null,
        },

        monthlyTrends: months,

        calendarMonthComparison:
          comparisonAvailable
            ? {
                current,
                previous,
                interpretation:
                  "event_counts_for_current_and_previous_calendar_month",
              }
            : {
                available: false,
                reason:
                  "Custom date filters do not include an unfiltered previous comparison period",
              },

        seafarerReadiness: {
          available: true,
          verified_operational_readiness: false,
          ready: kpis.ready_crew,
          conditionally_ready: kpis.conditionally_ready_crew,
          partially_ready: kpis.conditionally_ready_crew,
          not_ready: kpis.not_ready_crew,
          unassessed: kpis.unassessed_crew,
          certificate_hard_stop_crew: kpis.crew_with_certificate_hard_stops,
          readiness_percentage: kpis.readiness_percentage,
          average_matrix_readiness_score: kpis.average_matrix_readiness_score,
          gap_ranking: gaps.rows,
          basis: "stored_matrix_readiness_score_plus_existing_certificate_hard_stop_rule",
        },

        definitions: {
          ...fmiDefinitions,

          trendDates:
            "training_completed_at_assessment_submitted_at",
        },

        filters: scope.filters,
      },
    });
  } catch (error) {
    return fmiSendError(
      res,
      error,
      "getExecutiveCombinedAnalytics"
    );
  }
};



export const getCompanyCombinedAnalytics = async (req, res) => {
  try {
      await verifyAnalyticsRequest(req);
    const scope = fmiScope(req);

    // =====================================================
    // COMPANY INTELLIGENCE OVERVIEW
    // =====================================================

    const overviewQ = `
      ${fmiCombinedCte}

      SELECT
        COUNT(*)::int AS total_companies,

        COUNT(*) FILTER (
          WHERE co.is_active
        )::int AS active_companies,

        COUNT(*) FILTER (
          WHERE co.created_at >= COALESCE(
            f.date_from::timestamptz,
            CURRENT_DATE - INTERVAL '30 days'
          )

          AND co.created_at < COALESCE(
            (f.date_to + INTERVAL '1 day')::timestamptz,
            NOW()
          )
        )::int AS newly_registered_companies,

        ROUND(
          (
            SELECT COUNT(*)::numeric
            FROM fmi_ships
          )
          / NULLIF(COUNT(*), 0),
          2
        )::float8 AS average_fleet_size

      FROM fmi_companies co

      CROSS JOIN fmi_filter f
    `;

    // =====================================================
    // COMPANY PERFORMANCE MATRIX
    // =====================================================

    const matrixQ = `
      ${fmiCombinedCte},

      ship_counts AS (
        SELECT
          s.company_id,

          COUNT(*)::int AS ship_count,

          COUNT(DISTINCT s.ship_type)::int
            AS ship_type_count

        FROM fmi_ships s

        GROUP BY s.company_id
      ),

      crew_counts AS (
        SELECT
          p.company_id,

          ${fmiRollupSql("p")}

        FROM fmi_per_crew p

        GROUP BY p.company_id
      )

      SELECT
        co.company_id,
        co.company_name,
        co.code,
        co.is_active,
        co.created_at,

        COALESCE(s.ship_count, 0)
          AS ship_count,

        COALESCE(s.ship_type_count, 0)
          AS ship_type_count,

        COALESCE(c.crew_count, 0)
          AS crew_count,

        COALESCE(c.onboard_crew, 0)
          AS onboard_crew,

        COALESCE(c.offboard_crew, 0)
          AS offboard_crew,

        COALESCE(c.training_enrolments, 0)
          AS training_enrolments,

        COALESCE(c.training_completions, 0)
          AS training_completions,

        c.training_completion_rate,

        COALESCE(c.assessment_attempts, 0)
          AS assessment_attempts,

        COALESCE(c.evaluated_attempts, 0)
          AS evaluated_attempts,

        COALESCE(c.passed_attempts, 0)
          AS passed_attempts,

        c.assessment_pass_rate,

        c.average_assessment_score,

        COALESCE(c.certificates_held, 0)
          AS certificates_held,

        COALESCE(c.valid_certificates, 0)
          AS valid_certificates,

        COALESCE(c.expired_certificates, 0)
          AS expired_certificates,

        c.certificate_validity_percentage,

        COALESCE(c.ready_crew, 0) AS ready_crew,
        COALESCE(c.conditionally_ready_crew, 0) AS conditionally_ready_crew,
        COALESCE(c.not_ready_crew, 0) AS not_ready_crew,
        COALESCE(c.unassessed_crew, 0) AS unassessed_crew,
        c.readiness_percentage,
        c.average_matrix_readiness_score,
        COALESCE(c.matrix_total_assigned, 0) AS matrix_total_assigned,
        COALESCE(c.matrix_total_completed, 0) AS matrix_total_completed,

        NULL::float8 AS competency_score,
        NULL::float8 AS mandatory_compliance_percentage,
        NULL::int AS incident_count

      FROM fmi_companies co

      LEFT JOIN ship_counts s
        ON s.company_id = co.company_id

      LEFT JOIN crew_counts c
        ON c.company_id = co.company_id

      ORDER BY co.company_name
    `;

    // =====================================================
    // FLEET COMPOSITION BY SHIP TYPE
    // =====================================================

    const compositionQ = `
      ${fmiCombinedCte}

      SELECT
        co.company_id,
        co.company_name,

        COALESCE(
          s.ship_type,
          'Unspecified'
        ) AS ship_type,

        COUNT(*)::int AS vessel_count

      FROM fmi_ships s

      JOIN fmi_companies co
        ON co.company_id = s.company_id

      GROUP BY
        co.company_id,
        co.company_name,
        COALESCE(
          s.ship_type,
          'Unspecified'
        )

      ORDER BY
        co.company_name,
        vessel_count DESC
    `;

    const [
      overview,
      matrix,
      composition,
    ] = await Promise.all([
      db.query(overviewQ, scope.params),
      db.query(matrixQ, scope.params),
      db.query(compositionQ, scope.params),
    ]);

    return res.status(200).json({
      success: true,

      data: {
        overview: overview.rows[0],

        companyPerformanceMatrix: matrix.rows,

        fleetCompositionByShipType: composition.rows,

        incidentAnalytics: {
          available: false,

          reason:
            "Incident schema and consolidated metric definitions not supplied for this endpoint",
        },

        definitions: fmiDefinitions,

        filters: scope.filters,
      },
    });
  } catch (error) {
    return fmiSendError(
      res,
      error,
      "getCompanyCombinedAnalytics"
    );
  }
};



export const getFleetCombinedAnalytics = async (req, res) => {
  try {
      await verifyAnalyticsRequest(req);
    const scope = fmiScope(req);

    // =====================================================
    // VESSEL-WISE PERFORMANCE MATRIX
    // =====================================================

    const vesselQ = `
      ${fmiCombinedCte}

      SELECT
        s.ship_id,
        s.ship_name,
        s.imo_number,
        s.flag,
        s.ship_type,

        s.company_id,
        co.company_name,

        ${fmiRollupSql("p")},

        NULL::boolean AS is_active,

        NULL::float8 AS competency_score,

        NULL::float8 AS mandatory_compliance_percentage

      FROM fmi_ships s

      JOIN fmi_companies co
        ON co.company_id = s.company_id

      LEFT JOIN fmi_per_crew p
        ON p.ship_id = s.ship_id

      GROUP BY
        s.ship_id,
        s.ship_name,
        s.imo_number,
        s.flag,
        s.ship_type,
        s.company_id,
        co.company_name

      ORDER BY
        co.company_name,
        s.ship_name
    `;

    // =====================================================
    // RANK-WISE PERFORMANCE WITHIN EACH SHIP
    // =====================================================

    const rankQ = `
      ${fmiCombinedCte}

      SELECT
        p.ship_id,
        p.ship_name,

        COALESCE(
          p.rank,
          'Unknown'
        ) AS rank,

        ${fmiRollupSql("p")}

      FROM fmi_per_crew p

      WHERE p.ship_id IS NOT NULL

      GROUP BY
        p.ship_id,
        p.ship_name,
        COALESCE(p.rank, 'Unknown')

      ORDER BY
        p.ship_name,
        rank
    `;

    // =====================================================
    // COMPLETE SHIP CREW PERFORMANCE REGISTER
    // =====================================================

    const crewQ = `
      ${fmiCombinedCte}

      SELECT
        p.user_id,
        p.seafarer_id,
        p.full_name,
        p.rank,
        p.status,

        p.company_id,
        p.company_name,

        p.ship_id,
        p.ship_name,
        p.ship_type,

        p.training_enrolments,
        p.training_completed,

        ROUND(
          100.0 * p.training_completed
          / NULLIF(
            p.training_eligible,
            0
          ),
          2
        )::float8 AS training_completion_rate,

        p.assessment_attempts,
        p.assessment_passed,

        ROUND(
          100.0 * p.assessment_passed
          / NULLIF(
            p.assessment_evaluated,
            0
          ),
          2
        )::float8 AS assessment_pass_rate,

        ROUND(
          p.assessment_score_sum
          / NULLIF(
            p.assessment_score_count,
            0
          ),
          2
        )::float8 AS average_assessment_score,

        p.certificates_held,
        p.certificates_valid,
        p.certificates_expired,
        p.certificates_expiring_soon,

        ROUND(
          100.0 * p.certificates_valid
          / NULLIF(
            p.certificates_held,
            0
          ),
          2
        )::float8 AS certificate_validity_percentage,

        p.readiness_score,
        p.readiness_status,
        p.certificate_hard_stops,
        p.matrix_total_assigned,
        p.matrix_total_completed,

        NULL::float8 AS competency_score

      FROM fmi_per_crew p

      WHERE p.ship_id IS NOT NULL

      ORDER BY
        p.ship_name,
        p.rank NULLS LAST,
        p.full_name
    `;

    const [
      vessels,
      ranks,
      crew,
    ] = await Promise.all([
      db.query(vesselQ, scope.params),
      db.query(rankQ, scope.params),
      db.query(crewQ, scope.params),
    ]);

    const shipRows = vessels.rows;

    const shipTypes = [
      ...new Set(
        shipRows
          .map((s) => s.ship_type)
          .filter(Boolean)
      ),
    ];

    const onboardSum = shipRows.reduce(
      (sum, s) =>
        sum + Number(s.onboard_crew || 0),
      0
    );

    return res.status(200).json({
      success: true,

      data: {
        fleetOverview: {
          total_ships: shipRows.length,

          active_ships: null,

          vessel_types: shipTypes.length,

          manned_vessels: shipRows.filter(
            (s) => s.onboard_crew > 0
          ).length,

          average_onboard_crew_per_vessel:
            shipRows.length
              ? Number(
                  (
                    onboardSum / shipRows.length
                  ).toFixed(2)
                )
              : null,
        },

        vesselPerformanceMatrix: shipRows,

        shipRankPerformance: ranks.rows,

        shipCrewPerformanceRegister: crew.rows,

        vesselReadiness: {
          available: true,
          verified_operational_readiness: false,
          byVessel: shipRows.map((ship) => ({
            ship_id: ship.ship_id,
            ship_name: ship.ship_name,
            ready_crew: ship.ready_crew,
            conditionally_ready_crew: ship.conditionally_ready_crew,
            partially_ready_crew: ship.conditionally_ready_crew,
            not_ready_crew: ship.not_ready_crew,
            unassessed_crew: ship.unassessed_crew,
            readiness_percentage: ship.readiness_percentage,
            average_matrix_readiness_score: ship.average_matrix_readiness_score,
          })),
        },

        definitions: {
          ...fmiDefinitions,

          mannedVessel:
            "at_least_one_current_onboard_crew",

          shipActivityStatus:
            "not_stored_in_ships_table",
        },

        filters: scope.filters,
      },
    });
  } catch (error) {
    return fmiSendError(
      res,
      error,
      "getFleetCombinedAnalytics"
    );
  }
};



export const getSeafarerCombinedAnalytics = async (req, res) => {
  try {
      await verifyAnalyticsRequest(req);
    const scope = fmiScope(req);

    // =====================================================
    // CREW OVERVIEW
    // =====================================================

    const summaryQ = `
      ${fmiCombinedCte}

      SELECT
        ${fmiRollupSql("p")},

        COUNT(p.user_id) FILTER (
          WHERE p.created_at >= COALESCE(
            f.date_from::timestamptz,
            CURRENT_DATE - INTERVAL '30 days'
          )

          AND p.created_at < COALESCE(
            (f.date_to + INTERVAL '1 day')::timestamptz,
            NOW()
          )
        )::int AS newly_registered_crew,

        NULL::int AS active_crew,

        NULL::int AS inactive_crew

      FROM fmi_per_crew p

      CROSS JOIN fmi_filter f
    `;

    // =====================================================
    // RANK-WISE PERFORMANCE MATRIX
    // =====================================================

    const rankQ = `
      ${fmiCombinedCte}

      SELECT
        COALESCE(
          p.rank,
          'Unknown'
        ) AS rank,

        ${fmiRollupSql("p")}

      FROM fmi_per_crew p

      GROUP BY
        COALESCE(p.rank, 'Unknown')

      ORDER BY
        crew_count DESC,
        rank
    `;

    // =====================================================
    // CREW STATUS DISTRIBUTION
    // =====================================================

    const statusQ = `
      ${fmiCombinedCte}

      SELECT
        COALESCE(
          p.status,
          'Unknown'
        ) AS status,

        COUNT(*)::int AS crew_count

      FROM fmi_per_crew p

      GROUP BY
        COALESCE(p.status, 'Unknown')

      ORDER BY
        crew_count DESC,
        status
    `;

    // =====================================================
    // COMPLETE CREW PERFORMANCE REGISTER
    // =====================================================

    const crewQ = `
      ${fmiCombinedCte}

      SELECT
        p.user_id,
        p.seafarer_id,
        p.full_name,
        p.rank,
        p.status,

        p.company_id,
        p.company_name,

        p.ship_id,
        p.ship_name,

        p.embarkation_date,
        p.disembarkation_date,
        p.trip,

        p.training_enrolments,
        p.training_assigned,
        p.training_completed,

        ROUND(
          100.0 * p.training_completed
          / NULLIF(
            p.training_eligible,
            0
          ),
          2
        )::float8 AS training_completion_rate,

        p.assessment_attempts,
        p.assessment_passed,
        p.assessment_failed,

        ROUND(
          100.0 * p.assessment_passed
          / NULLIF(
            p.assessment_evaluated,
            0
          ),
          2
        )::float8 AS assessment_pass_rate,

        ROUND(
          p.assessment_score_sum
          / NULLIF(
            p.assessment_score_count,
            0
          ),
          2
        )::float8 AS average_assessment_score,

        p.certificates_held,
        p.certificates_valid,
        p.certificates_expired,
        p.certificates_expiring_soon,

        ROUND(
          100.0 * p.certificates_valid
          / NULLIF(
            p.certificates_held,
            0
          ),
          2
        )::float8 AS certificate_validity_percentage,

        NULL::float8 AS competency_score,

        p.readiness_score,
        p.readiness_status,
        p.certificate_hard_stops,
        p.matrix_total_assigned,
        p.matrix_total_completed

      FROM fmi_per_crew p

      ORDER BY
        p.full_name,
        p.user_id
    `;

    const [
      summary,
      ranks,
      statuses,
      crew,
    ] = await Promise.all([
      db.query(summaryQ, scope.params),
      db.query(rankQ, scope.params),
      db.query(statusQ, scope.params),
      db.query(crewQ, scope.params),
    ]);

    return res.status(200).json({
      success: true,

      data: {
        overview: summary.rows[0],

        byRank: ranks.rows,

        byStatus: statuses.rows,

        seafarerPerformanceRegister: crew.rows,

        departmentAnalytics: {
          available: false,

          reason:
            "users has no verified department mapping",
        },

        definitions: {
          ...fmiDefinitions,

          onboardStatus:
            "LOWER(users.status) = 'onboard'",

          offboardStatus:
            "LOWER(users.status) = 'offboard'",
        },

        filters: scope.filters,
      },
    });
  } catch (error) {
    return fmiSendError(
      res,
      error,
      "getSeafarerCombinedAnalytics"
    );
  }
};



export const getSeafarerCompetencyPassport = async (req, res) => {
  try {
      await verifyAnalyticsRequest(req);
    const userId = fmiPositiveId(
      req.params.userId,
      "userId"
    );

    if (!userId) {
      throw fmiError(400, "userId is required");
    }

    const role = Number(req.user?.role_id);

    if (![1, 2].includes(role)) {
      throw fmiError(403, "Access denied");
    }

    const params = [userId];

    const where = [
      "u.user_id = $1",
      "u.role_id = 4",
    ];

    // Company Admin
    if (role === 2) {
      if (!req.user?.company_id) {
        throw fmiError(
          403,
          "Company scope missing"
        );
      }

      params.push(req.user.company_id);

      where.push(
        `u.company_id = $${params.length}`
      );
    }

    // =====================================================
    // PROFILE
    // =====================================================

    const profileResult = await db.query(
      `
      SELECT
        u.user_id,
        u.seafarer_id,
        u.full_name,
        u.rank,
        u.status,
        u.trip,
        u.nationality,
        u.company_id,
        u.ship_id,
        u.embarkation_date,
        u.disembarkation_date,

        co.company_name,

        sh.ship_name,
        sh.ship_type,
        sh.imo_number

      FROM public.users u

      LEFT JOIN public.company co
        ON co.company_id = u.company_id

      LEFT JOIN public.ships sh
        ON sh.ship_id = u.ship_id

      WHERE ${where.join(" AND ")}
      `,
      params
    );

    const profile = profileResult.rows[0];

    if (!profile) {
      return res.status(404).json({
        success: false,
        message: "Seafarer not found or inaccessible",
      });
    }

    // =====================================================
    // TRAINING, ASSESSMENTS, CERTIFICATES, SHIP HISTORY
    // =====================================================

    const [
      training,
      completionHistory,
      attempts,
      certificates,
      shipHistory,
    ] = await Promise.all([
      // TRAINING ENROLLMENTS
      db.query(
        `
        SELECT
          ce.id AS enrollment_id,
          ce.course_id,

          cr.title AS course_title,
          cr.department AS training_category,
          cr.content_mode,

          ce.assigned,
          ce.enrolled_by,
          ce.enrolled_at,
          ce.status AS enrollment_status,
          ce.completion_status,
          ce.completed_at,
          ce.certificate_issued

        FROM public.course_enrollments ce

        JOIN public.courses cr
          ON cr.id = ce.course_id
          AND cr.deleted_at IS NULL

        WHERE ce.user_id = $1

          AND (
            cr.company_id IS NULL
            OR cr.company_id = $2::uuid
          )

        ORDER BY
          ce.enrolled_at DESC,
          ce.id DESC
        `,
        [
          userId,
          profile.company_id,
        ]
      ),

      // TRAINING COMPLETION HISTORY
      db.query(
        `
        SELECT
          h.completion_id,
          h.course_id,

          cr.title AS course_title,

          h.completed_at,
          h.assigned

        FROM public.course_completion_history h

        JOIN public.courses cr
          ON cr.id = h.course_id
          AND cr.deleted_at IS NULL

        WHERE h.user_id = $1

          AND (
            cr.company_id IS NULL
            OR cr.company_id = $2::uuid
          )

        ORDER BY
          h.completed_at DESC,
          h.completion_id DESC
        `,
        [
          userId,
          profile.company_id,
        ]
      ),

      // ASSESSMENT ATTEMPTS
      db.query(
        `
        SELECT
          aa.attempt_id,
          aa.assessment_id,

          a.title AS assessment_title,
          a.assessment_type,
          a.category,

          aa.attempt_number,
          aa.status,
          aa.score_obtained,
          aa.percentage,
          aa.is_passed,

          aa.started_at,
          aa.submitted_at,
          aa.subjective_pending_review

        FROM public.assessment_attempts aa

        JOIN public.assessments a
          ON a.assessment_id = aa.assessment_id
          AND a.is_deleted = false

        WHERE aa.user_id = $1

          AND (
            a.company_id IS NULL
            OR a.company_id = $2::uuid
          )

        ORDER BY
          a.title,
          aa.started_at ASC,
          aa.attempt_number ASC
        `,
        [
          userId,
          profile.company_id,
        ]
      ),

      // CERTIFICATES
      db.query(
        `
        SELECT
          c.certificate_id,
          c.certificate_uid,
          c.certificate_name,
          c.certificate_type,

          c.issue_date,
          c.expiry_date,

          c.score,
          c.grade,

          ${fmiCertificateStatusSql("c")}
            AS computed_status,

          (
            c.expiry_date - CURRENT_DATE
          )::int AS days_until_expiry

        FROM public.certificates c

        WHERE c.user_id = $1

          AND (
            c.company_id IS NULL
            OR c.company_id = $2::uuid
          )

        ORDER BY
          c.issue_date DESC NULLS LAST,
          c.certificate_id DESC
        `,
        [
          userId,
          profile.company_id,
        ]
      ),

      // SHIP ASSIGNMENT HISTORY
      db.query(
        `
        SELECT
          h.history_id,
          h.company_id,
          h.ship_id,

          h.embarkation_date,
          h.disembarkation_date,
          h.embarkation_port,
          h.disembarkation_port,
          h.created_at,

          sh.ship_name,
          co.company_name

        FROM public.user_ship_history h

        LEFT JOIN public.ships sh
          ON sh.ship_id = h.ship_id

        LEFT JOIN public.company co
          ON co.company_id = h.company_id

        WHERE h.user_id = $1

          AND (
            $2::uuid IS NULL
            OR h.company_id = $2::uuid
          )

        ORDER BY
          h.embarkation_date DESC NULLS LAST,
          h.history_id DESC
        `,
        [
          userId,

          role === 2
            ? req.user.company_id
            : null,
        ]
      ),
    ]);

    // Current assignment was already authorized by profile query;
    // matrix company_id/ship_id may be stale after transfer.
    const matrixResult = await db.query(
      `SELECT m.* FROM public.user_competency_matrix m
       JOIN public.users u ON u.user_id = m.user_id
       WHERE u.user_id = $1
         AND ($2::uuid IS NULL OR u.company_id = $2::uuid)`,
      [userId, role === 2 ? req.user.company_id : null]
    );
    const matrix = matrixResult.rows[0] || null;

    const categoryBreakdown = matrix
      ? FMI_MATRIX_DOMAINS.map(([category, key]) => {
          const assigned = Number(matrix[`${key}_total_assigned`] ?? 0);
          const completed = Number(matrix[`${key}_total_completed`] ?? 0);
          return {
            category,
            assigned,
            completed,
            outstanding: Math.max(assigned - completed, 0),
            completion_rate: assigned > 0
              ? Number((100 * completed / assigned).toFixed(2))
              : null,
          };
        })
      : [];

    const matrixReadinessScore = matrix?.readiness_score == null
      ? null : Number(matrix.readiness_score);
    const hardStopCertificates = certificates.rows.filter(
      (c) => ["expired", "revoked", "failed"].includes(c.computed_status)
    ).length;
    const passportReadinessStatus = fmiReadinessStatus(
      matrixReadinessScore,
      hardStopCertificates > 0
    );

    // =====================================================
    // ASSESSMENT SUMMARY
    // =====================================================

    const evaluated = attempts.rows.filter(
      (a) =>
        a.status === "evaluated" &&
        a.is_passed !== null
    );

    const passed = evaluated.filter(
      (a) => a.is_passed === true
    ).length;

    const assessedWithScore = evaluated.filter(
      (a) => a.percentage != null
    );

    const assessedScoreAverage =
      assessedWithScore.length
        ? Number(
            (
              assessedWithScore.reduce(
                (sum, a) =>
                  sum + Number(a.percentage),
                0
              ) / assessedWithScore.length
            ).toFixed(2)
          )
        : null;

    // =====================================================
    // ASSESSMENT SCORE PROGRESSION
    // =====================================================

    const trends = new Map();

    for (const a of attempts.rows) {
      if (
        a.status !== "evaluated" ||
        a.percentage == null
      ) {
        continue;
      }

      const key = a.assessment_id;

      if (!trends.has(key)) {
        trends.set(key, {
          assessment_id: key,
          title: a.assessment_title,
          scores: [],
        });
      }

      trends.get(key).scores.push({
        attempt_id: a.attempt_id,
        attempt_number: a.attempt_number,
        score: Number(a.percentage),
      });
    }

    const scoreProgression = [
      ...trends.values(),
    ].map((t) => ({
      ...t,

      first_score:
        t.scores[0]?.score ?? null,

      latest_score:
        t.scores[t.scores.length - 1]?.score ?? null,

      improvement_points:
        t.scores.length > 1
          ? Number(
              (
                t.scores[t.scores.length - 1].score -
                t.scores[0].score
              ).toFixed(2)
            )
          : null,
    }));

    // =====================================================
    // TRAINING SUMMARY
    // =====================================================

    const activeEnrollments = training.rows.filter(
      (t) =>
        t.enrollment_status !== "cancelled"
    );

    const completedTraining =
      activeEnrollments.filter(
        (t) =>
          t.completion_status === "completed"
      ).length;

    // =====================================================
    // CERTIFICATE SUMMARY
    // =====================================================

    const validCertificates =
      certificates.rows.filter(
        (c) =>
          [
            "active",
            "expiring_soon",
          ].includes(c.computed_status)
      ).length;

    // =====================================================
    // FINAL RESPONSE
    // =====================================================

    return res.status(200).json({
      success: true,

      data: {
        profile,

        activitySummary: {
          enrolments: activeEnrollments.length,

          completed_trainings: completedTraining,

          training_completion_rate:
            activeEnrollments.length
              ? Number(
                  (
                    completedTraining *
                    100 /
                    activeEnrollments.length
                  ).toFixed(2)
                )
              : null,

          total_assessment_attempts:
            attempts.rows.length,

          evaluated_attempts:
            evaluated.length,

          passed_attempts: passed,

          assessment_pass_rate:
            evaluated.length
              ? Number(
                  (
                    passed *
                    100 /
                    evaluated.length
                  ).toFixed(2)
                )
              : null,

          average_assessment_score:
            assessedScoreAverage,

          certificates_held:
            certificates.rows.length,

          valid_certificates:
            validCertificates,

          certificate_validity_percentage:
            certificates.rows.length
              ? Number(
                  (
                    validCertificates *
                    100 /
                    certificates.rows.length
                  ).toFixed(2)
                )
              : null,

          competency_score: null,

          readiness_score: matrixReadinessScore,
          readiness_status: passportReadinessStatus,
          readiness_percentage: matrixReadinessScore,
          certificate_hard_stops: hardStopCertificates,
        },

        training: {
          records: training.rows,
          completionHistory:
            completionHistory.rows,
          actual_learning_hours: null,
        },

        assessments: {
          attempts: attempts.rows,
          scoreProgression,
        },

        certification: {
          certificates: certificates.rows,
        },

        shipHistory: {
          records: shipHistory.rows,
          rankHistoryAvailable: false,
        },

        competency: {
          training_category_matrix_available: matrix !== null,
          verified_professional_competency_available: false,
          categoryBreakdown,
          totalAssigned: categoryBreakdown.reduce((sum, c) => sum + c.assigned, 0),
          totalCompleted: categoryBreakdown.reduce((sum, c) => sum + c.completed, 0),
          matrixUpdatedAt: matrix?.updated_at ?? null,
        },

        readiness: {
          available: passportReadinessStatus !== "unassessed",
          verified_operational_readiness: false,
          readiness_score: matrixReadinessScore,
          status: passportReadinessStatus,
          certificate_hard_stop_count: hardStopCertificates,
          scoring_basis: "stored_matrix_score_and_existing_certificate_hard_stop_rule",
          reason: passportReadinessStatus === "unassessed"
            ? "No matrix score or hard-stop certificate is recorded"
            : null,
        },

        definitions: {
          ...fmiDefinitions,

          pagination: false,

          assignmentDate:
            "enrolled_at_is_not_a_verified_assignment_date",
        },
      },
    });
  } catch (error) {
    return fmiSendError(
      res,
      error,
      "getSeafarerCompetencyPassport"
    );
  }
};
