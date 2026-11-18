import { db } from "../db.js";

// Assumed table names and columns:
// ships(ship_id, ship_name)
// companies(company_id, company_name)

const USER_FROM = `
  FROM users u
  LEFT JOIN ships s
    ON s.ship_id = u.ship_id
  LEFT JOIN company c
    ON c.company_id = u.company_id
`;

const USER_COLUMNS = `
  SELECT
    u.user_id,
    u.full_name,
    u.seafarer_id,
    u.rank,
    u.username,
    u.email,
    u.ship_id,
    s.ship_name AS ship,
    u.company_id,
    c.company_name AS company,
    u.role_id,
    u.created_at AS added_on,
    u.updated_at AS last_updated
  ${USER_FROM}
`;

// GET /api/dashboard/users/recent
// Returns users grouped by registration date for the last 7 calendar days.

export const getRecentUsers = async (req, res) => {
    try {
        const query = `
      WITH days AS (
        SELECT generate_series(
          CURRENT_DATE - INTERVAL '6 days',
          CURRENT_DATE,
          INTERVAL '1 day'
        )::date AS added_date
      )
      SELECT
        TO_CHAR(d.added_date, 'YYYY-MM-DD') AS date,
        COUNT(u.user_id)::int AS count,

        COALESCE(
          JSON_AGG(
            JSON_BUILD_OBJECT(
              'user_id', u.user_id,
              'full_name', u.full_name,
              'seafarer_id', u.seafarer_id,
              'rank', u.rank,
              'username', u.username,
              'email', u.email,
              'ship_id', u.ship_id,
              'ship', s.ship_name,
              'company_id', u.company_id,
              'company', c.company_name,
              'role_id', u.role_id,
              'added_on', u.created_at,
              'last_updated', u.updated_at
            )
            ORDER BY u.created_at DESC
          ) FILTER (WHERE u.user_id IS NOT NULL),
          '[]'::json
        ) AS users

      FROM days d
      LEFT JOIN users u
        ON u.created_at >= d.added_date
        AND u.created_at < d.added_date + INTERVAL '1 day'
      LEFT JOIN ships s
        ON s.ship_id = u.ship_id
      LEFT JOIN company c
        ON c.company_id = u.company_id

      GROUP BY d.added_date
      ORDER BY d.added_date DESC;
    `;

        const result = await db.query(query);

        const totalNewUsers = result.rows.reduce(
            (total, day) => total + day.count,
            0
        );

        return res.status(200).json({
            success: true,
            totalNewUsers,
            days: result.rows,
        });
    } catch (error) {
        console.error("Error fetching day-wise users:", error);

        return res.status(500).json({
            success: false,
            message: "Failed to fetch day-wise users",
        });
    }
};

// GET /api/users?page=1&limit=20&search=rahul
export const getAllUsers = async (req, res) => {
    try {
        const page = Math.max(
            Number.parseInt(req.query.page, 10) || 1,
            1
        );

        const requestedLimit =
            Number.parseInt(req.query.limit, 10) || 20;

        const limit = Math.min(Math.max(requestedLimit, 1), 100);
        const offset = (page - 1) * limit;
        const search = String(req.query.search || "").trim();

        let whereClause = "";
        const values = [];

        if (search) {
            values.push(`%${search}%`);

            whereClause = `
        WHERE
          u.full_name ILIKE $1
          OR u.seafarer_id ILIKE $1
          OR u.rank ILIKE $1
          OR u.username ILIKE $1
          OR u.email ILIKE $1
          OR s.ship_name ILIKE $1
          OR c.company_name ILIKE $1
      `;
        }

        // Total matching users for pagination
        const countQuery = `
      SELECT COUNT(DISTINCT u.user_id) AS total
      ${USER_FROM}
      ${whereClause}
    `;

        const countResult = await db.query(countQuery, values);
        const total = Number(countResult.rows[0].total);

        // Fetch the current page
        const dataValues = [...values];
        dataValues.push(limit);
        dataValues.push(offset);

        const limitPosition = dataValues.length - 1;
        const offsetPosition = dataValues.length;

        const dataQuery = `
      ${USER_COLUMNS}
      ${whereClause}
      ORDER BY
        u.created_at DESC NULLS LAST,
        u.user_id DESC
      LIMIT $${limitPosition}
      OFFSET $${offsetPosition}
    `;

        const result = await db.query(dataQuery, dataValues);

        return res.status(200).json({
            success: true,
            data: result.rows,
            pagination: {
                page,
                limit,
                total,
                totalPages: Math.ceil(total / limit),
            },
        });
    } catch (error) {
        console.error("Error fetching users:", error);

        return res.status(500).json({
            success: false,
            message: "Failed to fetch users",
        });
    }
};


// GET /api/dashboard/users/recent/all
// Returns ALL users added in the last 7 days, without a limit.

export const getNewUsersLast7Days = async (req, res) => {
  try {
    const query = `
      ${USER_COLUMNS}
      WHERE u.created_at >= NOW() - INTERVAL '7 days'
      ORDER BY
        u.created_at DESC NULLS LAST,
        u.user_id DESC
    `;

    const result = await db.query(query);

    return res.status(200).json({
      success: true,
      count: result.rows.length,
      data: result.rows,
    });
  } catch (error) {
    console.error("Error fetching new users:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch users added in the last 7 days",
    });
  }
};


// GET /api/dashboard/users/recent-activity
// Returns users who have activity logs in the last 15 days.
// Superadmin: all companies
// Admin: own company only


export const getUsersWithRecentActivity = async (req, res) => {
  try {
    const roleId = Number(req.user?.role_id);
    const companyId = req.user?.company_id;

    // Only Superadmin and Company Admin can access this API.
    if (![1, 2].includes(roleId)) {
      return res.status(403).json({
        success: false,
        message: "Access denied",
      });
    }

    // Company Admin must have a company assigned.
    if (roleId === 2 && !companyId) {
      return res.status(403).json({
        success: false,
        message: "Admin company not found",
      });
    }

    // Superadmin: all companies.
    // Company Admin: own company only.
    const values = [];
    let userScope = "";

    if (roleId === 2) {
      values.push(companyId);
      userScope = `AND u.company_id = $1`;
    }

    const query = `
      WITH activity_events AS (
        SELECT
          al.activity_id::text AS event_id,
          al.user_id,
          'activity'::text AS source,
          al.activity_type,
          al.training_type,
          COALESCE(
            al.training_type,
            al.activity_type,
            'Activity'
          ) AS title,
          al.occurred_at AS event_timestamp,

          NULL::numeric AS progress_percentage,
          NULL::boolean AS is_completed,
          NULL::timestamptz AS started_at,
          NULL::timestamptz AS completed_at,

          al.payload_json AS payload,
          NULL::text AS sync_status,
          NULL::jsonb AS unity_data

        FROM activity_logs al

        WHERE al.occurred_at >= NOW() - INTERVAL '15 days'
          AND al.occurred_at <= NOW()
      ),

      unity_events AS (
        SELECT
          CONCAT(
            'unity_',
            ucs.id::text,
            '_',
            COALESCE(r.result->>'index', '0')
          ) AS event_id,

          NULLIF(r.result->>'user_id', '')::integer AS user_id,

          'unity'::text AS source,

          'unity_course_progress'::text AS activity_type,

          r.result->>'unity_course_code' AS training_type,

          COALESCE(
            r.result->>'course_name',
            r.result->>'unity_course_code',
            'Unity Course Activity'
          ) AS title,

          NULLIF(
            r.result->'progress'->>'last_activity_at',
            ''
          )::timestamptz AS event_timestamp,

          CASE
            WHEN r.result->'progress'->>'progress_percentage'
              ~ '^-?[0-9]+(\\.[0-9]+)?$'
            THEN (
              r.result->'progress'->>'progress_percentage'
            )::numeric
            ELSE NULL
          END AS progress_percentage,

          CASE
            WHEN LOWER(
              r.result->'progress'->>'is_completed'
            ) IN ('true', 'false')
            THEN (
              r.result->'progress'->>'is_completed'
            )::boolean
            ELSE NULL
          END AS is_completed,

          NULLIF(
            r.result->'progress'->>'started_at',
            ''
          )::timestamptz AS started_at,

          NULLIF(
            r.result->'progress'->>'completed_at',
            ''
          )::timestamptz AS completed_at,

          NULL::jsonb AS payload,

          ucs.status AS sync_status,

          r.result AS unity_data

        FROM unity_course_sync_logs ucs

        CROSS JOIN LATERAL jsonb_array_elements(
          COALESCE(
            ucs.raw_response->'results',
            '[]'::jsonb
          )
        ) AS r(result)

        WHERE NULLIF(
          r.result->'progress'->>'last_activity_at',
          ''
        )::timestamptz >= NOW() - INTERVAL '15 days'

          AND NULLIF(
            r.result->'progress'->>'last_activity_at',
            ''
          )::timestamptz <= NOW()
      ),

      all_events AS (
        SELECT * FROM activity_events

        UNION ALL

        SELECT * FROM unity_events
      )

      SELECT
        u.user_id,
        u.full_name,
        u.seafarer_id,
        u.rank,
        u.username,
        u.email,

        u.ship_id,
        s.ship_name AS ship,

        u.company_id,
        c.company_name AS company,

        u.role_id,

        COUNT(e.event_id)::int AS total_activities,

        MAX(e.event_timestamp) AS last_activity_at,

        JSON_AGG(
          JSON_BUILD_OBJECT(
            'id', e.event_id,
            'source', e.source,
            'activity_type', e.activity_type,
            'training_type', e.training_type,
            'title', e.title,
            'timestamp', e.event_timestamp,
            'progress_percentage', e.progress_percentage,
            'is_completed', e.is_completed,
            'started_at', e.started_at,
            'completed_at', e.completed_at,
            'payload', e.payload,
            'unity_data', e.unity_data,
            'sync_status', e.sync_status
          )
          ORDER BY e.event_timestamp DESC
        ) AS activities

      FROM all_events e

      INNER JOIN users u
        ON u.user_id = e.user_id

      LEFT JOIN ships s
        ON s.ship_id = u.ship_id

      LEFT JOIN company c
        ON c.company_id = u.company_id

      WHERE 1 = 1
        ${userScope}

      GROUP BY
        u.user_id,
        u.full_name,
        u.seafarer_id,
        u.rank,
        u.username,
        u.email,
        u.ship_id,
        s.ship_name,
        u.company_id,
        c.company_name,
        u.role_id

      ORDER BY MAX(e.event_timestamp) DESC;
    `;

    const result = await db.query(query, values);

    return res.status(200).json({
      success: true,
      count: result.rows.length,
      data: result.rows,
    });

  } catch (error) {
    console.error(
      "Error fetching users with recent activity:",
      error
    );

    return res.status(500).json({
      success: false,
      message: "Failed to fetch users with recent activity",
    });
  }
};

