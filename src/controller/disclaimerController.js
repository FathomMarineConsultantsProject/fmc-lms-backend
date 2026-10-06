import { db } from "../db.js";

// ==========================================
// DISCLAIMER CONTROLLERS
// ==========================================

// Record disclaimer acceptance
// Available to every logged-in user
export const acceptDisclaimer = async (req, res) => {
    try {
        const userId = req.user?.user_id || req.user?.id;

        if (!userId) {
            return res.status(401).json({
                error: "Unauthorized: User ID not found."
            });
        }

        const parsedUserId = parseInt(userId, 10);

        if (isNaN(parsedUserId)) {
            return res.status(400).json({
                error: "Invalid user ID."
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
            [parsedUserId]
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
// Only Role 1 can access this
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