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

// GET /api/users/recent?limit=10
export const getRecentUsers = async (req, res) => {
    try {
        const requestedLimit = Number.parseInt(req.query.limit, 10) || 10;
        const limit = Math.min(Math.max(requestedLimit, 1), 10);

        const query = `
      ${USER_COLUMNS}
      ORDER BY
        u.created_at DESC NULLS LAST,
        u.user_id DESC
      LIMIT $1
    `;

        const result = await db.query(query, [limit]);

        return res.status(200).json({
            success: true,
            count: result.rows.length,
            data: result.rows,
        });
    } catch (error) {
        console.error("Error fetching recent users:", error);

        return res.status(500).json({
            success: false,
            message: "Failed to fetch recent users",
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