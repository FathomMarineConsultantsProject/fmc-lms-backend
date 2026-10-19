import { db } from "../db.js";

// ==========================================
// DISCLAIMER CONTROLLERS
// ==========================================

// User accepts disclaimer
export const acceptDisclaimer = async (req, res) => {
    try {
        const userId = req.user?.user_id;

        console.log("REQ.USER:", req.user);
        console.log("USER ID:", userId);

        if (!userId) {
            return res.status(401).json({
                error: "Unauthorized: User ID not found."
            });
        }

        const result = await db.query(
            `
            INSERT INTO user_disclaimer_acceptances (user_id)
            VALUES ($1)
            RETURNING
                acceptance_id,
                user_id,
                accepted_at
            `,
            [userId]
        );

        return res.status(201).json({
            message: "Disclaimer accepted successfully.",
            acceptance: result.rows[0]
        });

    } catch (error) {
        console.error("Error recording disclaimer acceptance:", error);

        return res.status(500).json({
            error: "Failed to record disclaimer acceptance."
        });
    }
};


// ==========================================
// GET DISCLAIMER ACCEPTANCE HISTORY
// ROLE 1 ONLY
// ==========================================

export const getDisclaimerAcceptances = async (req, res) => {

    const roleId = Number(req.user?.role_id);

    if (roleId !== 1) {
        return res.status(403).json({
            error: "Forbidden: Super Admin access required."
        });
    }

    try {
        const result = await db.query(
            `
            SELECT
                uda.acceptance_id,
                u.user_id,
                u.full_name AS user_name,
                u.ship_id,
                u.company_id,
                uda.accepted_at
            FROM user_disclaimer_acceptances uda
            INNER JOIN users u
                ON u.user_id = uda.user_id
            ORDER BY uda.accepted_at DESC
            `
        );

        return res.status(200).json({
            acceptances: result.rows
        });

    } catch (error) {
        console.error(
            "Error fetching disclaimer acceptance records:",
            error
        );

        return res.status(500).json({
            error: "Failed to fetch disclaimer acceptance records."
        });
    }
};