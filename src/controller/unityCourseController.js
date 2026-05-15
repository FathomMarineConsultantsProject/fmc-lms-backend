// src/controller/unityCourseController.js
import { db } from '../db.js';

/**
 * =============================================================================
 * UNITY COURSE CONTROLLER
 * =============================================================================
 *
 * This controller currently handles ONLY 2 APIs:
 *
 * 1. POST /unity-courses/progress/track
 *    - Called by Unity app.
 *    - Unity sends user course progress data.
 *    - Backend stores/updates data in:
 *      - unity_courses
 *      - unity_course_progress
 *      - unity_course_sync_logs
 *
 * 2. GET /unity-courses/progress
 *    - Called by dashboard/admin/frontend.
 *    - Returns Unity course progress joined with common users table.
 *    - Also returns user rank, ship, and company details.
 *
 * Analytics APIs like rank-wise/ship-wise summary can be added later.
 * For now, this single GET API gives all data needed to filter on frontend
 * or later build analytics APIs.
 * =============================================================================
 */

/**
 * Simple API key protection for Unity calls.
 *
 * Add this in .env:
 * UNITY_COURSE_API_KEY=some_secret
 *
 * We also accept ACTIVITY_API_KEY as fallback so Unity can follow
 * the same pattern as the existing activity tracking API.
 */
const requireUnityCourseKey = (req, res) => {
  const key =
    req.headers['x-unity-course-key'] ||
    req.headers['unity_course_api_key'] ||
    req.headers['unity-course-api-key'] ||
    req.headers['activity_api_key'] ||
    req.headers['activity-api-key'] ||
    req.headers['x-activity-key'];

  const expected =
    process.env.UNITY_COURSE_API_KEY ||
    process.env.ACTIVITY_API_KEY;

  // If key is not configured in env, allow request.
  // But in production, keep UNITY_COURSE_API_KEY in env.
  if (!expected) return true;

  if (String(key || '') !== String(expected)) {
    res.status(401).json({ error: 'Invalid Unity course key' });
    return false;
  }

  return true;
};

/**
 * Parse timestamp coming from Unity.
 *
 * Supported formats:
 * - "YYYY-MM-DD-HH:mm" example: "2026-05-14-10:45"
 * - ISO string example: "2026-05-14T10:45:00Z"
 * - any valid JS Date string
 */
const parseUnityTimestamp = (value) => {
  if (!value) return null;

  const s = String(value).trim();

  // Format 1: YYYY-MM-DD-HH
  // Example: 2026-05-14-11
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})-(\d{2})$/);
  if (m) {
    const [, Y, M, D, h] = m;

    return new Date(
      Number(Y),
      Number(M) - 1,
      Number(D),
      Number(h),
      0,
      0
    );
  }

  // Format 2: YYYY-MM-DD-HH:mm
  // Example: 2026-05-14-11:30
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})-(\d{2}):(\d{2})$/);
  if (m) {
    const [, Y, M, D, h, min] = m;

    return new Date(
      Number(Y),
      Number(M) - 1,
      Number(D),
      Number(h),
      Number(min),
      0
    );
  }

  // Format 3: ISO string fallback
  // Example: 2026-05-14T11:30:00Z
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;

  return d;
};

/**
 * Converts different possible completed values into true/false.
 *
 * Accepts:
 * true, false, 1, 0, "true", "false", "completed", "incomplete"
 */
const parseBoolean = (value) => {
  if (value === true || value === false) return value;

  if (value === null || value === undefined || value === '') return null;

  if (typeof value === 'number') {
    if (value === 1) return true;
    if (value === 0) return false;
  }

  const s = String(value).trim().toLowerCase();

  if (['true', '1', 'yes', 'y', 'completed', 'complete'].includes(s)) {
    return true;
  }

  if (['false', '0', 'no', 'n', 'incomplete', 'not_completed'].includes(s)) {
    return false;
  }

  return null;
};

/**
 * Makes sure progress is always between 0 and 100.
 */
const clampProgress = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
};

/**
 * Helper for dynamic SQL filters.
 */
const addFilter = (filters, values, sql, value) => {
  if (value === undefined || value === null || value === '') return;

  values.push(value);
  filters.push(sql.replace('?', `$${values.length}`));
};

/**
 * Applies role-based visibility to GET /unity-courses/progress.
 *
 * Role logic:
 * - role_id 1: Super Admin can see all data and filter by company/ship/user.
 * - role_id 2: Company Admin can see only own company.
 * - role_id 3: Ship/Sub Admin can see only own ship.
 * - role_id 4: Crew can see only own data.
 */
const addUserScopeFilters = (req, filters, values, alias = 'u') => {
  const roleId = Number(req.user?.role_id);
  const loginCompanyId = req.user?.company_id;
  const loginShipId = req.user?.ship_id;
  const loginUserId = req.user?.user_id;

  const {
    company_id: qCompanyId,
    ship_id: qShipId,
    user_id: qUserId,
  } = req.query || {};

  // ROLE 1: Super Admin
  if (roleId === 1) {
    addFilter(filters, values, `${alias}.company_id = ?`, qCompanyId ? String(qCompanyId) : null);
    addFilter(filters, values, `${alias}.ship_id = ?`, qShipId ? Number(qShipId) : null);
    addFilter(filters, values, `${alias}.user_id = ?`, qUserId ? Number(qUserId) : null);
    return;
  }

  // ROLE 2: Company Admin
  if (roleId === 2) {
    if (!loginCompanyId) {
      filters.push('1 = 0');
      return;
    }

    addFilter(filters, values, `${alias}.company_id = ?`, String(loginCompanyId));
    addFilter(filters, values, `${alias}.ship_id = ?`, qShipId ? Number(qShipId) : null);
    addFilter(filters, values, `${alias}.user_id = ?`, qUserId ? Number(qUserId) : null);
    return;
  }

  // ROLE 3: Ship/Sub Admin
  if (roleId === 3) {
    if (!loginShipId) {
      filters.push('1 = 0');
      return;
    }

    addFilter(filters, values, `${alias}.ship_id = ?`, Number(loginShipId));
    addFilter(filters, values, `${alias}.user_id = ?`, qUserId ? Number(qUserId) : null);
    return;
  }

  // ROLE 4: Crew
  if (roleId === 4) {
    if (!loginUserId) {
      filters.push('1 = 0');
      return;
    }

    addFilter(filters, values, `${alias}.user_id = ?`, Number(loginUserId));
    return;
  }

  // Unknown role cannot see data.
  filters.push('1 = 0');
};

/**
 * Course filters for GET /unity-courses/progress.
 *
 * Supported query params:
 * - course_code
 * - unity_course_code
 * - course_id
 * - unity_course_id
 */
const addCourseFilters = (req, filters, values, alias = 'uc') => {
  const {
    course_code,
    unity_course_code,
    course_id,
    unity_course_id,
  } = req.query || {};

  const finalCourseCode = course_code || unity_course_code;
  const finalCourseId = course_id || unity_course_id;

  addFilter(
    filters,
    values,
    `${alias}.unity_course_code = ?`,
    finalCourseCode ? String(finalCourseCode) : null
  );

  addFilter(
    filters,
    values,
    `${alias}.unity_course_id = ?`,
    finalCourseId ? Number(finalCourseId) : null
  );
};

/**
 * Normalize Unity payload into one internal object.
 *
 * Unity can send different naming styles:
 * - user_id or userId
 * - username or login_id
 * - unity_course_code or courseCode or trainingType
 * - progress_percentage or progressPercentage or progress
 */
const normalizeProgressRecord = (raw = {}) => {
  const userId = raw.user_id ?? raw.userId ?? null;

  const username =
    raw.username ??
    raw.login_id ??
    raw.loginId ??
    raw.LOGIN_ID ??
    null;

  const seafarerId =
    raw.seafarer_id ??
    raw.seafarerId ??
    null;

  const unityCourseCode = String(
    raw.unity_course_code ??
    raw.unityCourseCode ??
    raw.course_code ??
    raw.courseCode ??
    raw.course_id ??
    raw.courseId ??
    raw.trainingType ??
    ''
  ).trim();

  if (!unityCourseCode) {
    throw new Error('unity_course_code / courseCode is required');
  }

  if (!userId && !username && !seafarerId) {
    throw new Error('user_id or username or seafarer_id is required');
  }

  const courseName = String(
    raw.course_name ??
    raw.courseName ??
    raw.trainingType ??
    unityCourseCode
  ).trim();

  const courseDescription =
    raw.course_description ??
    raw.courseDescription ??
    null;

  const rawProgress =
    raw.progress_percentage ??
    raw.progressPercentage ??
    raw.percentage ??
    raw.progress ??
    null;

  let isCompleted = parseBoolean(
    raw.is_completed ??
    raw.isCompleted ??
    raw.completed ??
    raw.status
  );

  let progressPercentage =
    rawProgress === null || rawProgress === undefined || rawProgress === ''
      ? isCompleted === true
        ? 100
        : 0
      : clampProgress(rawProgress);

  // If progress is 100, force completed true.
  if (progressPercentage >= 100) {
    isCompleted = true;
  }

  // If Unity did not send completed flag, default to false.
  if (isCompleted === null) {
    isCompleted = false;
  }

  // If completed is true, force percentage to 100.
  if (isCompleted) {
    progressPercentage = 100;
  }

  const startedAt = parseUnityTimestamp(
    raw.started_at ??
    raw.startedAt ??
    raw.start_time ??
    raw.startTime
  );

  const lastActivityAt =
    parseUnityTimestamp(
      raw.last_activity_at ??
      raw.lastActivityAt ??
      raw.timestamp ??
      raw.updated_at ??
      raw.updatedAt
    ) || new Date();

  let completedAt = parseUnityTimestamp(
    raw.completed_at ??
    raw.completedAt ??
    raw.completion_time ??
    raw.completionTime
  );

  // If course is completed and Unity did not send completed_at,
  // use last_activity_at/current time.
  if (isCompleted && !completedAt) {
    completedAt = lastActivityAt || new Date();
  }

  return {
    userId,
    username,
    seafarerId,
    unityCourseCode,
    courseName,
    courseDescription,
    progressPercentage,
    isCompleted,
    startedAt,
    completedAt,
    lastActivityAt,
    unityRawUserId: raw.unity_user_id ?? raw.unityUserId ?? username ?? seafarerId ?? userId,
    unityRawCourseId: raw.unity_raw_course_id ?? raw.unityRawCourseId ?? raw.courseId ?? raw.course_id ?? unityCourseCode,
    raw,
  };
};

/**
 * Finds common LMS user from users table.
 *
 * Matching priority:
 * 1. user_id
 * 2. username
 * 3. seafarer_id
 */
const resolveUser = async (record) => {
  if (record.userId) {
    const { rows } = await db.query(
      `
      SELECT
        user_id,
        username,
        seafarer_id,
        full_name,
        rank,
        company_id,
        ship_id,
        role_id
      FROM users
      WHERE user_id = $1
      LIMIT 1
      `,
      [Number(record.userId)]
    );

    if (rows[0]) return rows[0];
  }

  if (record.username) {
    const { rows } = await db.query(
      `
      SELECT
        user_id,
        username,
        seafarer_id,
        full_name,
        rank,
        company_id,
        ship_id,
        role_id
      FROM users
      WHERE username = $1 OR seafarer_id = $1
      LIMIT 1
      `,
      [String(record.username)]
    );

    if (rows[0]) return rows[0];
  }

  if (record.seafarerId) {
    const { rows } = await db.query(
      `
      SELECT
        user_id,
        username,
        seafarer_id,
        full_name,
        rank,
        company_id,
        ship_id,
        role_id
      FROM users
      WHERE seafarer_id = $1
      LIMIT 1
      `,
      [String(record.seafarerId)]
    );

    if (rows[0]) return rows[0];
  }

  return null;
};

/**
 * Inserts/updates Unity course master data.
 *
 * This is separate from your existing web LMS courses table.
 */
const upsertUnityCourse = async (record) => {
  const { rows } = await db.query(
    `
    INSERT INTO unity_courses (
      unity_course_code,
      course_name,
      course_description
    )
    VALUES ($1, $2, $3)
    ON CONFLICT (unity_course_code)
    DO UPDATE SET
      course_name = COALESCE(NULLIF(EXCLUDED.course_name, ''), unity_courses.course_name),
      course_description = COALESCE(NULLIF(EXCLUDED.course_description, ''), unity_courses.course_description),
      updated_at = CURRENT_TIMESTAMP
    RETURNING
      unity_course_id,
      unity_course_code,
      course_name,
      course_description,
      is_active,
      created_at,
      updated_at
    `,
    [
      record.unityCourseCode,
      record.courseName || record.unityCourseCode,
      record.courseDescription,
    ]
  );

  return rows[0];
};

/**
 * Inserts/updates user course progress.
 *
 * Important logic:
 * - One row per user per Unity course.
 * - If progress increases, keep highest progress.
 * - If completed once, keep completed true.
 * - If completed true, completed_at is stored.
 */
const upsertUnityCourseProgress = async (user, course, record) => {
  const { rows } = await db.query(
    `
    INSERT INTO unity_course_progress (
      user_id,
      unity_course_id,
      progress_percentage,
      is_completed,
      started_at,
      completed_at,
      last_activity_at,
      unity_raw_user_id,
      unity_raw_course_id,
      raw_payload
    )
    VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb
    )
    ON CONFLICT (user_id, unity_course_id)
    DO UPDATE SET
      progress_percentage = GREATEST(
        COALESCE(unity_course_progress.progress_percentage, 0),
        COALESCE(EXCLUDED.progress_percentage, 0)
      ),
      is_completed =
        unity_course_progress.is_completed
        OR EXCLUDED.is_completed
        OR GREATEST(
          COALESCE(unity_course_progress.progress_percentage, 0),
          COALESCE(EXCLUDED.progress_percentage, 0)
        ) >= 100,
      started_at = COALESCE(unity_course_progress.started_at, EXCLUDED.started_at),
      completed_at = CASE
        WHEN
          unity_course_progress.is_completed
          OR EXCLUDED.is_completed
          OR GREATEST(
            COALESCE(unity_course_progress.progress_percentage, 0),
            COALESCE(EXCLUDED.progress_percentage, 0)
          ) >= 100
        THEN COALESCE(unity_course_progress.completed_at, EXCLUDED.completed_at, CURRENT_TIMESTAMP)
        ELSE NULL
      END,
      last_activity_at = CASE
        WHEN unity_course_progress.last_activity_at IS NULL THEN EXCLUDED.last_activity_at
        WHEN EXCLUDED.last_activity_at IS NULL THEN unity_course_progress.last_activity_at
        ELSE GREATEST(unity_course_progress.last_activity_at, EXCLUDED.last_activity_at)
      END,
      unity_raw_user_id = COALESCE(EXCLUDED.unity_raw_user_id, unity_course_progress.unity_raw_user_id),
      unity_raw_course_id = COALESCE(EXCLUDED.unity_raw_course_id, unity_course_progress.unity_raw_course_id),
      raw_payload = EXCLUDED.raw_payload,
      updated_at = CURRENT_TIMESTAMP
    RETURNING
      progress_id,
      user_id,
      unity_course_id,
      progress_percentage,
      is_completed,
      started_at,
      completed_at,
      last_activity_at,
      created_at,
      updated_at
    `,
    [
      user.user_id,
      course.unity_course_id,
      record.progressPercentage,
      record.isCompleted,
      record.startedAt,
      record.completedAt,
      record.lastActivityAt,
      record.unityRawUserId ? String(record.unityRawUserId) : null,
      record.unityRawCourseId ? String(record.unityRawCourseId) : null,
      JSON.stringify(record.raw),
    ]
  );

  return rows[0];
};

/**
 * Full processing of one Unity progress record:
 * 1. Normalize payload
 * 2. Resolve user from users table
 * 3. Upsert Unity course
 * 4. Upsert Unity course progress
 */
const processUnityProgressRecord = async (raw) => {
  const record = normalizeProgressRecord(raw);

  const user = await resolveUser(record);
  if (!user) {
    throw new Error(
      `User not found for user_id=${record.userId || ''}, username=${record.username || ''}, seafarer_id=${record.seafarerId || ''}`
    );
  }

  const course = await upsertUnityCourse(record);
  const progress = await upsertUnityCourseProgress(user, course, record);

  return {
    user,
    course,
    progress,
  };
};

/**
 * =============================================================================
 * API 1: POST /unity-courses/progress/track
 * =============================================================================
 *
 * This is the ONLY API Unity developer needs to call for sending course data.
 *
 * Headers:
 * Content-Type: application/json
 * UNITY_COURSE_API_KEY: your_secret
 *
 * Single record body:
 * {
 *   "user_id": 2110,
 *   "unity_course_code": "FIRE_SAFETY",
 *   "course_name": "Fire Safety Training",
 *   "progress_percentage": 80,
 *   "is_completed": false,
 *   "started_at": "2026-05-14-10:00",
 *   "last_activity_at": "2026-05-14-10:45"
 * }
 *
 * Batch body is also supported:
 * {
 *   "records": [
 *     { ... },
 *     { ... }
 *   ]
 * }
 */
export const trackUnityCourseProgress = async (req, res) => {
  if (!requireUnityCourseKey(req, res)) return;

  const body = req.body || {};

  const records = Array.isArray(body)
    ? body
    : Array.isArray(body.records)
      ? body.records
      : Array.isArray(body.progress)
        ? body.progress
        : [body];

  if (!records.length) {
    return res.status(400).json({ error: 'No course progress records received' });
  }

  const results = [];
  let successRecords = 0;
  let failedRecords = 0;

  for (let index = 0; index < records.length; index += 1) {
    try {
      const result = await processUnityProgressRecord(records[index]);

      successRecords += 1;

      results.push({
        index,
        success: true,
        user_id: result.user.user_id,
        username: result.user.username,
        seafarer_id: result.user.seafarer_id,
        unity_course_id: result.course.unity_course_id,
        unity_course_code: result.course.unity_course_code,
        course_name: result.course.course_name,
        progress: result.progress,
      });
    } catch (err) {
      failedRecords += 1;

      results.push({
        index,
        success: false,
        error: err.message || 'Failed to process record',
      });
    }
  }

  /**
   * Store sync summary.
   * This helps debugging if Unity sends wrong payload/user/course data.
   */
  try {
    const status =
      failedRecords === 0
        ? 'success'
        : successRecords > 0
          ? 'partial_success'
          : 'failed';

    const errorMessage = failedRecords
      ? results
          .filter((r) => !r.success)
          .map((r) => `index ${r.index}: ${r.error}`)
          .join('; ')
          .slice(0, 2000)
      : null;

    await db.query(
      `
      INSERT INTO unity_course_sync_logs (
        sync_type,
        status,
        total_records,
        success_records,
        failed_records,
        error_message,
        raw_response
      )
      VALUES (
        'course_progress',
        $1,
        $2,
        $3,
        $4,
        $5,
        $6::jsonb
      )
      `,
      [
        status,
        records.length,
        successRecords,
        failedRecords,
        errorMessage,
        JSON.stringify({ results }),
      ]
    );
  } catch (logErr) {
    console.error('Error writing unity_course_sync_logs:', logErr);
  }

  if (successRecords === 0) {
    return res.status(400).json({
      message: 'No Unity course progress records were saved',
      total_records: records.length,
      success_records: successRecords,
      failed_records: failedRecords,
      results,
    });
  }

  return res.status(failedRecords > 0 ? 207 : 201).json({
    message: failedRecords > 0
      ? 'Unity course progress partially saved'
      : 'Unity course progress saved',
    total_records: records.length,
    success_records: successRecords,
    failed_records: failedRecords,
    results,
  });
};

/**
 * =============================================================================
 * API 2: GET /unity-courses/progress
 * =============================================================================
 *
 * This is the ONE GET API for dashboard/reporting.
 *
 * Returns stored Unity course progress with user details.
 *
 * Supported filters:
 * - company_id
 * - ship_id
 * - user_id
 * - rank
 * - course_code
 * - unity_course_code
 * - course_id
 * - unity_course_id
 * - completed=true/false
 * - is_completed=true/false
 * - search
 * - limit
 * - offset
 *
 * Example:
 * GET /unity-courses/progress?rank=MASTER&completed=true
 */
export const getUnityCourseProgress = async (req, res) => {
  try {
    const {
      completed,
      is_completed,
      search,
      rank,
      limit = 100,
      offset = 0,
    } = req.query;

    const lim = Math.min(Number(limit) || 100, 500);
    const off = Math.max(Number(offset) || 0, 0);

    const filters = [];
    const values = [];

    // Apply role based access.
    addUserScopeFilters(req, filters, values, 'u');

    // Apply course filters.
    addCourseFilters(req, filters, values, 'uc');

    // Filter by completed status.
    const completedValue = parseBoolean(completed ?? is_completed);
    if (completedValue !== null) {
      addFilter(filters, values, 'ucp.is_completed = ?', completedValue);
    }

    // Filter by rank.
    // Case-insensitive exact match.
    // Example: ?rank=MASTER
    if (rank) {
      addFilter(filters, values, 'LOWER(u.rank) = LOWER(?)', String(rank));
    }

    // Search user/course text.
    if (search) {
      values.push(`%${String(search)}%`);
      filters.push(`
        (
          u.full_name ILIKE $${values.length}
          OR u.username ILIKE $${values.length}
          OR u.seafarer_id ILIKE $${values.length}
          OR u.rank ILIKE $${values.length}
          OR uc.course_name ILIKE $${values.length}
          OR uc.unity_course_code ILIKE $${values.length}
        )
      `);
    }

    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

    values.push(lim);
    const limitParam = values.length;

    values.push(off);
    const offsetParam = values.length;

    const sql = `
      SELECT
        ucp.progress_id,
        ucp.user_id,

        u.seafarer_id,
        u.username,
        u.full_name,
        u.rank,

        u.company_id,
        c.company_name,

        u.ship_id,
        s.ship_name,

        uc.unity_course_id,
        uc.unity_course_code,
        uc.course_name,
        uc.course_description,

        ucp.progress_percentage,
        ucp.is_completed,
        ucp.started_at,
        ucp.completed_at,
        ucp.last_activity_at,
        ucp.created_at,
        ucp.updated_at,

        ucp.unity_raw_user_id,
        ucp.unity_raw_course_id,
        ucp.raw_payload
      FROM unity_course_progress ucp
      JOIN unity_courses uc
        ON uc.unity_course_id = ucp.unity_course_id
      JOIN users u
        ON u.user_id = ucp.user_id
      LEFT JOIN company c
        ON c.company_id = u.company_id
      LEFT JOIN ships s
        ON s.ship_id = u.ship_id
      ${where}
      ORDER BY
        ucp.last_activity_at DESC NULLS LAST,
        ucp.updated_at DESC
      LIMIT $${limitParam}
      OFFSET $${offsetParam}
    `;

    const { rows } = await db.query(sql, values);

    return res.json(rows);
  } catch (err) {
    console.error('Error getUnityCourseProgress:', err);
    return res.status(500).json({ error: 'Failed to fetch Unity course progress' });
  }
};