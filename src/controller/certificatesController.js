import { db } from "../db.js";

const ROLE_SUPERADMIN = 1;
const ROLE_ADMIN = 2;
const ROLE_SUBADMIN = 3;
const ROLE_CREW = 4;

const COURSE_CONTENT_MODES = ["course", "single_training"];

function normalizeType(value) {
  return String(value || "").trim().toLowerCase();
}

function isPositiveInt(value) {
  const num = Number(value);
  return Number.isInteger(num) && num > 0;
}

function normalizePrefix(prefix) {
  return String(prefix || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 4);
}

function formatDDMMYY(date = new Date()) {
  const dd = String(date.getDate()).padStart(2, "0");
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const yy = String(date.getFullYear()).slice(-2);
  return `${dd}${mm}${yy}`;
}

function addMonths(dateInput, months) {
  const date = new Date(dateInput);
  const d = new Date(date);
  d.setMonth(d.getMonth() + months);
  return d;
}

function toDateOnlyString(dateInput) {
  const date = new Date(dateInput);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

async function generateCertificateUid(client, prefix) {
  const cleanPrefix = normalizePrefix(prefix);

  if (!cleanPrefix || cleanPrefix.length !== 4) {
    throw new Error("Certificate prefix must be exactly 4 characters");
  }

  const datePart = formatDDMMYY(new Date());
  const base = `FMC_${cleanPrefix}_${datePart}_`;

  const { rows } = await client.query(
    `
    SELECT certificate_uid
    FROM certificates
    WHERE certificate_uid LIKE $1
    ORDER BY certificate_uid DESC
    LIMIT 1
    `,
    [`${base}%`]
  );

  let nextSerial = 1;

  if (rows.length) {
    const lastUid = rows[0].certificate_uid;
    const lastSerial = parseInt(lastUid.split("_").pop(), 10);
    if (!Number.isNaN(lastSerial)) {
      nextSerial = lastSerial + 1;
    }
  }

  return `${base}${String(nextSerial).padStart(3, "0")}`;
}

async function getUserById(userId) {
  const { rows } = await db.query(
    `
    SELECT
      u.user_id,
      u.username,
      u.full_name,
      u.seafarer_id,
      u.rank,
      u.status,
      u.email,
      u.company_id,
      u.ship_id,
      c.company_name,
      s.ship_name
    FROM users u
    LEFT JOIN company c ON c.company_id = u.company_id
    LEFT JOIN ships s ON s.ship_id = u.ship_id
    WHERE u.user_id = $1
    LIMIT 1
    `,
    [userId]
  );

  return rows[0] || null;
}

async function getIssuerById(userId) {
  const { rows } = await db.query(
    `
    SELECT user_id, full_name
    FROM users
    WHERE user_id = $1
    LIMIT 1
    `,
    [userId]
  );

  return rows[0] || null;
}

function enforceUserScope(req, targetUser) {
  const role = Number(req.user?.role_id);

  if (role === ROLE_SUPERADMIN) return true;

  if (role === ROLE_ADMIN) {
    return String(targetUser.company_id) === String(req.user.company_id);
  }

  if (role === ROLE_SUBADMIN) {
    return (
      String(targetUser.company_id) === String(req.user.company_id) &&
      Number(targetUser.ship_id) === Number(req.user.ship_id)
    );
  }

  if (role === ROLE_CREW) {
    return Number(targetUser.user_id) === Number(req.user.user_id);
  }

  return false;
}

function buildCertificateScope(req, alias = "c") {
  const role = Number(req.user?.role_id);

  if (role === ROLE_SUPERADMIN) {
    return { where: "TRUE", params: [] };
  }

  if (role === ROLE_ADMIN) {
    return {
      where: `${alias}.company_id = $1`,
      params: [req.user.company_id],
    };
  }

  if (role === ROLE_SUBADMIN) {
    return {
      where: `${alias}.company_id = $1 AND ${alias}.ship_id = $2`,
      params: [req.user.company_id, req.user.ship_id],
    };
  }

  return {
    where: `${alias}.user_id = $1`,
    params: [req.user.user_id],
  };
}

function getComputedStatusSql(alias = "c") {
  return `
    CASE
      WHEN LOWER(COALESCE(${alias}.status, 'active')) = 'revoked' THEN 'revoked'
      WHEN ${alias}.expiry_date IS NOT NULL AND ${alias}.expiry_date < CURRENT_DATE THEN 'expired'
      WHEN ${alias}.expiry_date IS NOT NULL
           AND ${alias}.expiry_date >= CURRENT_DATE
           AND ${alias}.expiry_date <= CURRENT_DATE + INTERVAL '14 days' THEN 'expiring_soon'
      ELSE 'active'
    END
  `;
}

async function findExistingCertificate(client, certificateType, userId, courseId, assessmentId) {
  if (certificateType === "assessment") {
    const { rows } = await client.query(
      `
      SELECT certificate_id, certificate_uid
      FROM certificates
      WHERE user_id = $1
        AND assessment_id = $2
      LIMIT 1
      `,
      [userId, assessmentId]
    );
    return rows[0] || null;
  }

  const { rows } = await client.query(
    `
    SELECT certificate_id, certificate_uid
    FROM certificates
    WHERE user_id = $1
      AND course_id = $2
      AND certificate_type = $3
    LIMIT 1
    `,
    [userId, courseId, certificateType]
  );

  return rows[0] || null;
}

async function getActiveIssueForCourse(client, courseId, reqUser) {
  const params = [courseId];
  let extra = "";
  let p = 2;

  if (Number(reqUser.role_id) === ROLE_ADMIN) {
    extra += ` AND ci.company_id = $${p++}`;
    params.push(reqUser.company_id);
  } else if (Number(reqUser.role_id) === ROLE_SUBADMIN) {
    extra += ` AND ci.company_id = $${p++} AND (ci.ship_id = $${p++} OR ci.ship_id IS NULL)`;
    params.push(reqUser.company_id, reqUser.ship_id);
  }

  const { rows } = await client.query(
    `
    SELECT *
    FROM certificate_issues ci
    WHERE ci.source_type = 'course'
      AND ci.course_id = $1
      AND ci.issue_date <= NOW()
      AND ci.expiry_date >= CURRENT_DATE
      ${extra}
    ORDER BY ci.issue_date DESC, ci.issue_id DESC
    LIMIT 1
    `,
    params
  );

  return rows[0] || null;
}

async function getActiveIssueForAssessment(client, assessmentId, reqUser) {
  const params = [assessmentId];
  let extra = "";
  let p = 2;

  if (Number(reqUser.role_id) === ROLE_ADMIN) {
    extra += ` AND ci.company_id = $${p++}`;
    params.push(reqUser.company_id);
  } else if (Number(reqUser.role_id) === ROLE_SUBADMIN) {
    extra += ` AND ci.company_id = $${p++} AND (ci.ship_id = $${p++} OR ci.ship_id IS NULL)`;
    params.push(reqUser.company_id, reqUser.ship_id);
  }

  const { rows } = await client.query(
    `
    SELECT *
    FROM certificate_issues ci
    WHERE ci.source_type = 'assessment'
      AND ci.assessment_id = $1
      AND ci.issue_date <= NOW()
      AND ci.expiry_date >= CURRENT_DATE
      ${extra}
    ORDER BY ci.issue_date DESC, ci.issue_id DESC
    LIMIT 1
    `,
    params
  );

  return rows[0] || null;
}

// POST /certificates/issue
export const issueCertificate = async (req, res) => {
  const client = await db.connect();

  try {
    const requestType = normalizeType(req.body?.type);

    const courseId =
      req.body?.course_id != null && req.body?.course_id !== ""
        ? Number(req.body.course_id)
        : null;

    const assessmentId =
      req.body?.assessment_id != null && String(req.body.assessment_id).trim() !== ""
        ? String(req.body.assessment_id).trim()
        : null;

    const certificateName = String(req.body?.certificate_name || "").trim();
    const certificateDescription =
      req.body?.certificate_description != null
        ? String(req.body.certificate_description).trim()
        : null;

    const notes =
      req.body?.notes != null ? String(req.body.notes).trim() : null;

    const issuingAuthority =
      req.body?.issuing_authority != null && String(req.body.issuing_authority).trim() !== ""
        ? String(req.body.issuing_authority).trim()
        : "Fathom Marine Consultants";

    if (!["course", "assessment"].includes(requestType)) {
      return res.status(400).json({
        error: "type must be one of: course, assessment",
      });
    }

    if (!certificateName) {
      return res.status(400).json({ error: "certificate_name is required" });
    }

    const providedCount = (courseId != null ? 1 : 0) + (assessmentId ? 1 : 0);
    if (providedCount !== 1) {
      return res.status(400).json({
        error: "Exactly one of course_id or assessment_id is required",
      });
    }

    if (requestType === "course" && !isPositiveInt(courseId)) {
      return res.status(400).json({
        error: "Valid course_id is required for type=course",
      });
    }

    if (requestType === "assessment" && !assessmentId) {
      return res.status(400).json({
        error: "assessment_id is required for type=assessment",
      });
    }

    const issuer = await getIssuerById(req.user.user_id);
    const issueDateObj = new Date();
    const finalExpiryDate = toDateOnlyString(addMonths(issueDateObj, 3));

    let sourceCourseId = null;
    let sourceAssessmentId = null;
    let companyId = null;
    let shipId = null;
    let metadata = {};

    if (requestType === "course") {
      const { rows } = await client.query(
        `
        SELECT
          c.id,
          c.title,
          c.content_mode
        FROM courses c
        WHERE c.id = $1
          AND c.deleted_at IS NULL
        LIMIT 1
        `,
        [courseId]
      );

      const course = rows[0];
      if (!course) {
        return res.status(404).json({ error: "Course not found" });
      }

      const contentMode = normalizeType(course.content_mode);
      if (!COURSE_CONTENT_MODES.includes(contentMode)) {
        return res.status(400).json({
          error: "This course does not support certificate issuing",
        });
      }

      sourceCourseId = courseId;

      metadata = {
        source_table: "courses",
        content_mode: course.content_mode,
      };
    } else {
      const { rows } = await client.query(
        `
        SELECT
          a.assessment_id,
          a.title
        FROM assessments a
        WHERE a.assessment_id = $1
        LIMIT 1
        `,
        [assessmentId]
      );

      const assessment = rows[0];
      if (!assessment) {
        return res.status(404).json({ error: "Assessment not found" });
      }

      sourceAssessmentId = assessmentId;

      metadata = {
        source_table: "assessments",
      };
    }

    // For admin/subadmin keep their scope values.
    // For superadmin keep null, which is now allowed in DB.
    if (Number(req.user.role_id) !== ROLE_SUPERADMIN) {
      companyId = req.user.company_id ?? null;
      shipId = req.user.ship_id ?? null;
    }

    const { rows: existingRows } = await client.query(
      `
      SELECT issue_id
      FROM certificate_issues
      WHERE source_type = $1
        AND course_id IS NOT DISTINCT FROM $2
        AND assessment_id IS NOT DISTINCT FROM $3
        AND expiry_date >= CURRENT_DATE
      ORDER BY issue_date DESC, issue_id DESC
      LIMIT 1
      `,
      [requestType, sourceCourseId, sourceAssessmentId]
    );

    if (existingRows.length) {
      return res.status(409).json({
        error: "An active certificate issue already exists for this source",
      });
    }

    const insertResult = await client.query(
      `
      INSERT INTO certificate_issues (
        source_type,
        course_id,
        assessment_id,
        certificate_name,
        certificate_description,
        notes,
        issuing_authority,
        issue_date,
        expiry_date,
        issued_by_user_id,
        issued_by_name_snapshot,
        company_id,
        ship_id,
        created_at,
        updated_at
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7,
        NOW(), $8, $9, $10, $11, $12, NOW(), NOW()
      )
      RETURNING *
      `,
      [
        requestType,
        sourceCourseId,
        sourceAssessmentId,
        certificateName,
        certificateDescription,
        notes,
        issuingAuthority,
        finalExpiryDate,
        req.user.user_id,
        issuer?.full_name || null,
        companyId,
        shipId,
      ]
    );

    return res.status(201).json({
      message: "Certificate issue created successfully",
      data: insertResult.rows[0],
    });
  } catch (err) {
    console.error("issueCertificate error:", err);
    return res.status(500).json({
      error: "Failed to issue certificate",
      details: err.message,
    });
  } finally {
    client.release();
  }
};

// POST /certificates/generate
export const generateCertificate = async (req, res) => {
  const client = await db.connect();

  try {
    const requestType = normalizeType(req.body?.type);
    const userId = Number(req.user.user_id);

    const courseId =
      req.body?.course_id != null && req.body?.course_id !== ""
        ? Number(req.body.course_id)
        : null;

    const assessmentId =
      req.body?.assessment_id != null && String(req.body.assessment_id).trim() !== ""
        ? String(req.body.assessment_id).trim()
        : null;

    if (!["course", "assessment"].includes(requestType)) {
      return res.status(400).json({
        error: "type must be one of: course, assessment",
      });
    }

    const providedCount = (courseId != null ? 1 : 0) + (assessmentId ? 1 : 0);
    if (providedCount !== 1) {
      return res.status(400).json({
        error: "Exactly one of course_id or assessment_id is required",
      });
    }

    const targetUser = await getUserById(userId);
    if (!targetUser) {
      return res.status(404).json({ error: "User not found" });
    }

    let completion = null;
    let activeIssue = null;
    let finalCertificateType = null;
    let sourceCourseId = null;
    let sourceAssessmentId = null;
    let prefix = null;
    let metadata = {};

    if (requestType === "course") {
      if (!isPositiveInt(courseId)) {
        return res.status(400).json({ error: "Valid course_id is required for type=course" });
      }

      const { rows } = await client.query(
        `
        SELECT
          ce.user_id,
          ce.course_id,
          ce.completed_at,
          ce.completion_status,
          ce.certificate_issued,
          c.title AS item_title,
          c.content_mode,
          c.certificate_prefix
        FROM course_enrollments ce
        INNER JOIN courses c ON c.id = ce.course_id
        WHERE ce.user_id = $1
          AND ce.course_id = $2
          AND LOWER(COALESCE(ce.completion_status, '')) = 'completed'
          AND c.deleted_at IS NULL
        LIMIT 1
        `,
        [userId, courseId]
      );

      completion = rows[0] || null;
      if (!completion) {
        return res.status(400).json({
          error: "Completed course/training record not found for this user",
        });
      }

      const contentMode = normalizeType(completion.content_mode);
      if (!COURSE_CONTENT_MODES.includes(contentMode)) {
        return res.status(400).json({
          error: "This course does not support certificate generation",
        });
      }

      finalCertificateType = contentMode === "single_training" ? "training" : "course";
      sourceCourseId = courseId;
      prefix = completion.certificate_prefix;
      activeIssue = await getActiveIssueForCourse(client, courseId, req.user);

      metadata = {
        source_table: "courses",
        content_mode: completion.content_mode,
      };
    } else {
      if (!assessmentId) {
        return res.status(400).json({ error: "assessment_id is required for type=assessment" });
      }

      const { rows } = await client.query(
        `
        SELECT
          ar.user_id,
          ar.assessment_id,
          COALESCE(ar.completed_at, ar.created_at) AS completed_at,
          a.title AS item_title,
          a.certificate_prefix
        FROM assessment_results ar
        INNER JOIN assessments a ON a.assessment_id = ar.assessment_id
        WHERE ar.user_id = $1
          AND ar.assessment_id = $2
        ORDER BY COALESCE(ar.completed_at, ar.created_at) DESC
        LIMIT 1
        `,
        [userId, assessmentId]
      );

      completion = rows[0] || null;
      if (!completion) {
        return res.status(400).json({
          error: "Completed assessment record not found for this user",
        });
      }

      finalCertificateType = "assessment";
      sourceAssessmentId = assessmentId;
      prefix = completion.certificate_prefix;
      activeIssue = await getActiveIssueForAssessment(client, assessmentId, req.user);

      metadata = {
        source_table: "assessments",
      };
    }

    if (!activeIssue) {
      return res.status(400).json({
        error: "No active certificate issue found for this source",
      });
    }

    const cleanPrefix = normalizePrefix(prefix);
    if (cleanPrefix.length !== 4) {
      return res.status(400).json({
        error: "certificate_prefix is missing or invalid on the source item",
      });
    }

    await client.query("BEGIN");

    const existing = await findExistingCertificate(
      client,
      finalCertificateType,
      userId,
      sourceCourseId,
      sourceAssessmentId
    );

    if (existing) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        error: "Certificate already generated",
        data: existing,
      });
    }

    const certificateUid = await generateCertificateUid(client, cleanPrefix);

    const insertResult = await client.query(
      `
      INSERT INTO certificates (
        certificate_uid,
        certificate_type,
        certificate_name,
        certificate_description,
        user_id,
        company_id,
        ship_id,
        course_id,
        assessment_id,
        full_name_snapshot,
        seafarer_id_snapshot,
        company_name_snapshot,
        ship_name_snapshot,
        item_title_snapshot,
        completion_date,
        issue_date,
        expiry_date,
        status,
        score,
        grade,
        notes,
        issuing_authority,
        issued_by_user_id,
        issued_by_name_snapshot,
        file_url,
        metadata,
        created_at,
        updated_at
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7,
        $8, $9, $10, $11, $12, $13,
        $14, $15, NOW(), $16, 'active', $17,
        $18, $19, $20, $21, $22, NULL, $23, NOW(), NOW()
      )
      RETURNING *
      `,
      [
        certificateUid,
        finalCertificateType,
        activeIssue.certificate_name,
        activeIssue.certificate_description,
        userId,
        targetUser.company_id,
        targetUser.ship_id,
        sourceCourseId,
        sourceAssessmentId,
        targetUser.full_name,
        targetUser.seafarer_id,
        targetUser.company_name,
        targetUser.ship_name,
        completion.item_title,
        completion.completed_at,
        activeIssue.expiry_date,
        finalCertificateType === "assessment" ? null : null,
        finalCertificateType === "assessment" ? null : null,
        activeIssue.notes,
        activeIssue.issuing_authority,
        activeIssue.issued_by_user_id,
        activeIssue.issued_by_name_snapshot,
        JSON.stringify({
          ...metadata,
          certificate_issue_id: activeIssue.issue_id,
        }),
      ]
    );

    if (requestType === "course") {
      await client.query(
        `
        UPDATE course_enrollments
        SET certificate_issued = true,
            updated_at = NOW()
        WHERE user_id = $1
          AND course_id = $2
        `,
        [userId, courseId]
      );
    }

    await client.query("COMMIT");

    return res.status(201).json({
      message: "Certificate generated successfully",
      data: insertResult.rows[0],
    });
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {}

    console.error("generateCertificate error:", err);
    return res.status(500).json({
      error: "Failed to generate certificate",
      details: err.message,
    });
  } finally {
    client.release();
  }
};

// POST /certificates/filter
export const filterCertificates = async (req, res) => {
  try {
    const {
      user_id,
      search,
      certificate_type,
      status = "all",
      page = 1,
      limit = 20,
      date_from,
      date_to,
    } = req.body || {};

    const pageNum = Math.max(Number(page) || 1, 1);
    const limitNum = Math.min(Math.max(Number(limit) || 20, 1), 100);
    const offset = (pageNum - 1) * limitNum;

    const scope = buildCertificateScope(req, "c");
    const where = [scope.where];
    const params = [...scope.params];
    let p = params.length + 1;

    const statusSql = getComputedStatusSql("c");

    if (user_id != null && user_id !== "") {
      if (!isPositiveInt(user_id)) {
        return res.status(400).json({ error: "Invalid user_id filter" });
      }

      const targetUser = await getUserById(Number(user_id));
      if (!targetUser) {
        return res.status(404).json({ error: "User not found" });
      }

      if (!enforceUserScope(req, targetUser)) {
        return res.status(403).json({ error: "Forbidden" });
      }

      where.push(`c.user_id = $${p++}`);
      params.push(Number(user_id));
    }

    if (certificate_type && certificate_type !== "all") {
      const normalizedType = normalizeType(certificate_type);

      if (!["course", "training", "assessment"].includes(normalizedType)) {
        return res.status(400).json({
          error: "certificate_type must be one of: all, course, training, assessment",
        });
      }

      where.push(`LOWER(c.certificate_type) = $${p++}`);
      params.push(normalizedType);
    }

    if (status && status !== "all") {
      const normalizedStatus = normalizeType(status);

      if (!["active", "expired", "expiring_soon", "revoked"].includes(normalizedStatus)) {
        return res.status(400).json({
          error: "status must be one of: all, active, expired, expiring_soon, revoked",
        });
      }

      where.push(`${statusSql} = $${p++}`);
      params.push(normalizedStatus);
    }

    if (date_from) {
      where.push(`DATE(c.issue_date) >= $${p++}`);
      params.push(date_from);
    }

    if (date_to) {
      where.push(`DATE(c.issue_date) <= $${p++}`);
      params.push(date_to);
    }

    if (search && String(search).trim() !== "") {
      const q = `%${String(search).trim()}%`;
      where.push(`
        (
          c.certificate_uid ILIKE $${p}
          OR c.certificate_name ILIKE $${p}
          OR c.item_title_snapshot ILIKE $${p}
          OR c.full_name_snapshot ILIKE $${p}
          OR COALESCE(c.seafarer_id_snapshot, '') ILIKE $${p}
        )
      `);
      params.push(q);
      p += 1;
    }

    const whereClause = where.join(" AND ");

    const listQuery = `
      SELECT
        c.*,
        ${statusSql} AS computed_status
      FROM certificates c
      WHERE ${whereClause}
      ORDER BY c.issue_date DESC, c.certificate_id DESC
      LIMIT $${p++} OFFSET $${p++}
    `;

    const countQuery = `
      SELECT COUNT(*)::int AS total
      FROM certificates c
      WHERE ${whereClause}
    `;

    const statsQuery = `
      SELECT
        COUNT(*)::int AS total_certificates,
        COUNT(*) FILTER (WHERE ${statusSql} = 'active')::int AS active_certificates,
        COUNT(*) FILTER (WHERE ${statusSql} = 'expiring_soon')::int AS expiring_soon_certificates,
        COUNT(*) FILTER (WHERE ${statusSql} = 'expired')::int AS expired_certificates,
        COUNT(*) FILTER (WHERE ${statusSql} = 'revoked')::int AS revoked_certificates
      FROM certificates c
      WHERE ${whereClause}
    `;

    const listParams = [...params, limitNum, offset];

    const [listResult, countResult, statsResult] = await Promise.all([
      db.query(listQuery, listParams),
      db.query(countQuery, params),
      db.query(statsQuery, params),
    ]);

    return res.json({
      filters: {
        user_id: user_id ?? null,
        search: search ?? "",
        certificate_type: certificate_type ?? "all",
        status,
        date_from: date_from ?? null,
        date_to: date_to ?? null,
      },
      pagination: {
        page: pageNum,
        limit: limitNum,
        total: countResult.rows[0]?.total || 0,
      },
      summary: statsResult.rows[0] || {
        total_certificates: 0,
        active_certificates: 0,
        expiring_soon_certificates: 0,
        expired_certificates: 0,
        revoked_certificates: 0,
      },
      data: listResult.rows,
    });
  } catch (err) {
    console.error("filterCertificates error:", err);
    return res.status(500).json({
      error: "Failed to filter certificates",
      details: err.message,
    });
  }
};

// GET /certificates/my
export const getMyCertificates = async (req, res) => {
  try {
    const statusSql = getComputedStatusSql("c");

    const { rows } = await db.query(
      `
      SELECT c.*, ${statusSql} AS computed_status
      FROM certificates c
      WHERE c.user_id = $1
      ORDER BY c.issue_date DESC, c.certificate_id DESC
      `,
      [req.user.user_id]
    );

    return res.json(rows);
  } catch (err) {
    console.error("getMyCertificates error:", err);
    return res.status(500).json({ error: "Failed to fetch certificates" });
  }
};

// GET /certificates/user/:userId
export const getCertificatesByUserId = async (req, res) => {
  try {
    const userId = Number(req.params.userId);

    if (!isPositiveInt(userId)) {
      return res.status(400).json({ error: "Invalid userId" });
    }

    const targetUser = await getUserById(userId);
    if (!targetUser) {
      return res.status(404).json({ error: "User not found" });
    }

    if (!enforceUserScope(req, targetUser)) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const statusSql = getComputedStatusSql("c");

    const { rows } = await db.query(
      `
      SELECT c.*, ${statusSql} AS computed_status
      FROM certificates c
      WHERE c.user_id = $1
      ORDER BY c.issue_date DESC, c.certificate_id DESC
      `,
      [userId]
    );

    return res.json(rows);
  } catch (err) {
    console.error("getCertificatesByUserId error:", err);
    return res.status(500).json({ error: "Failed to fetch user certificates" });
  }
};

// GET /certificates/:id
export const getCertificateById = async (req, res) => {
  try {
    const certificateId = Number(req.params.id);

    if (!isPositiveInt(certificateId)) {
      return res.status(400).json({ error: "Invalid certificate id" });
    }

    const statusSql = getComputedStatusSql("c");

    const { rows } = await db.query(
      `
      SELECT c.*, ${statusSql} AS computed_status
      FROM certificates c
      WHERE c.certificate_id = $1
      LIMIT 1
      `,
      [certificateId]
    );

    if (!rows.length) {
      return res.status(404).json({ error: "Certificate not found" });
    }

    const cert = rows[0];

    const scopedUser = {
      user_id: cert.user_id,
      company_id: cert.company_id,
      ship_id: cert.ship_id,
    };

    if (!enforceUserScope(req, scopedUser)) {
      return res.status(403).json({ error: "Forbidden" });
    }

    return res.json(cert);
  } catch (err) {
    console.error("getCertificateById error:", err);
    return res.status(500).json({ error: "Failed to fetch certificate" });
  }
};

// POST /certificates/user-info
export const getUserInfoForCertificate = async (req, res) => {
  try {
    const role = Number(req.user?.role_id);

    const usernameRaw = req.body?.username;
    const userIdRaw = req.body?.user_id;

    const username =
      usernameRaw != null && String(usernameRaw).trim() !== ""
        ? String(usernameRaw).trim()
        : null;

    const user_id =
      userIdRaw != null && String(userIdRaw).trim() !== ""
        ? Number.parseInt(String(userIdRaw), 10)
        : null;

    if (!username && !Number.isInteger(user_id)) {
      return res.status(400).json({ error: "username or user_id is required" });
    }

    const where = [];
    const params = [];
    let p = 1;

    if (Number.isInteger(user_id)) {
      where.push(`u.user_id = $${p++}`);
      params.push(user_id);
    } else {
      where.push(`u.username = $${p++}`);
      params.push(username);
    }

    if (role === ROLE_SUPERADMIN) {
      // no restriction
    } else if (role === ROLE_ADMIN) {
      where.push(`u.company_id = $${p++}`);
      params.push(req.user.company_id);
    } else if (role === ROLE_SUBADMIN) {
      where.push(`u.company_id = $${p++}`);
      params.push(req.user.company_id);
      where.push(`u.ship_id = $${p++}`);
      params.push(req.user.ship_id);
    } else if (role === ROLE_CREW) {
      where.push(`u.user_id = $${p++}`);
      params.push(req.user.user_id);
    } else {
      return res.status(403).json({ error: "Forbidden" });
    }

    const { rows } = await db.query(
      `
      SELECT
        u.user_id,
        u.username,
        u.full_name,
        u.seafarer_id,
        u.rank,
        u.status,
        COALESCE(u.email, '') AS email,
        u.company_id,
        u.ship_id
      FROM users u
      WHERE ${where.join(" AND ")}
      LIMIT 1
      `,
      params
    );

    if (!rows.length) {
      return res.status(404).json({ error: "User not found (or outside your scope)" });
    }

    return res.json(rows[0]);
  } catch (err) {
    console.error("getUserInfoForCertificate error:", err);
    return res.status(500).json({ error: "Failed to fetch user info" });
  }
};