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
    const roleId = Number(req.user.role_id);
    const companyId = req.user.company_id;

    // Allow only Superadmin and Admin
    if (![1, 2].includes(roleId)) {
      return res.status(403).json({
        success: false,
        message: "Access denied",
      });
    }

    // Admin must have a company assigned
    if (roleId === 2 && !companyId) {
      return res.status(403).json({
        success: false,
        message: "Admin company not found",
      });
    }

    const values = [];
    let companyFilter = "";

    // Admin can only see users belonging to their company
    // Superadmin can see users from all companies
    if (roleId === 2) {
      values.push(companyId);
      companyFilter = `AND u.company_id = $${values.length}`;
    }

    const query = `
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

        COUNT(al.activity_id)::int AS total_activities,
        MAX(al.occurred_at) AS last_activity_at,

        JSON_AGG(
          JSON_BUILD_OBJECT(
            'activity_id', al.activity_id,
            'activity_type', al.activity_type,
            'training_type', al.training_type,
            'payload', al.payload_json,
            'occurred_at', al.occurred_at
          )
          ORDER BY al.occurred_at DESC
        ) AS activities

      FROM users u

      INNER JOIN activity_logs al
        ON al.user_id = u.user_id
        AND al.occurred_at >= NOW() - INTERVAL '15 days'
        AND al.occurred_at <= NOW()

      LEFT JOIN ships s
        ON s.ship_id = u.ship_id

      LEFT JOIN company c
        ON c.company_id = u.company_id

      WHERE 1 = 1
      ${companyFilter}

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

      ORDER BY MAX(al.occurred_at) DESC;
    `;

    const result = await db.query(query, values);

    return res.status(200).json({
      success: true,
      count: result.rows.length,
      data: result.rows,
    });

  } catch (error) {
    console.error("Error fetching users with recent activity:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch users with recent activity",
    });
  }
};
