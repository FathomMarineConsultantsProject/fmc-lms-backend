    import {db} from "../db.js";
 
    const getRoleId = (req) => Number(req.user?.role_id);
    const getAuthUserId = (req) => Number(req.user?.user_id);

    function getFetchScope(req) {
    const roleId = getRoleId(req);

    if (roleId === 1) {
        return {
        company_id: req.query.company_id || null,
        ship_id: req.query.ship_id || null,
        };
    }
    if (roleId === 2) {
        return {
        company_id: req.company_id || req.user?.company_id|| null,
        ship_id: req.query.ship_id || null,
        };
    } else {
        return {
        company_id: req.user?.company_id || null,
        ship_id: req.user?.ship_id || null,
        };
    }
    }

    //get logged in user competancy matrix
    export async function getMyCompetancyMatrix(req, res) {
    try {
        const userId = getAuthUserId(req);
        if (!userId) {
        return res.status(401).json({ message: "Unauthorized" });
        }
        const query = `
            SELECT 
                m.*, 
                u.full_name AS name,
                u.rank
            FROM user_competency_matrix m
            JOIN users u ON m.user_id = u.user_id
            WHERE m.user_id = $1
        `;
        const result = await db.query(query,[ userId ]);

        if (result.rows.length === 0) {
        return res.status(200).json({
            message: "No competancy matrix found for the user",
            data: null,
        });
        }
        return res.status(200).json({
        message: "Competancy matrix data fetched successfully",
        data: result.rows[0],
        });
    } catch (error) {
        console.error("getMyCompetencyMatrix error:", error);
        return res
        .status(500)
        .json({ message: "Server error", error: error.message });
    }
    }

    // get specific user competancy matrix
    export async function getUserCompetancyMatrixById(req, res) {
    try {
        const roleId = getRoleId(req);
        const targetUserId = Number(req.params.user_id);
        const {company_id, ship_id} = getFetchScope(req);

        if (!targetUserId || Number.isNaN(targetUserId)) {
        return res.status(400).json({ message: "Invalid user id provided" });
        }

        let query = `
            SELECT 
                m.*, 
                u.full_name AS name,
                u.rank
            FROM user_competency_matrix m
            JOIN users u ON m.user_id = u.user_id
            WHERE m.user_id = $1
        `;
        let queryParams = [targetUserId];
        let paramCount = 1;

        if (roleId === 2) {
            if (!company_id) {
                return res.status(403).json({ message: "Admin company id is missing" });
            }
                paramCount++;
                query += ` AND company_id = $${paramCount}`;
                queryParams.push(company_id);
            
        } else if (roleId === 3) {
        if (!ship_id) {
            return res.status(403).json({ message: "subadmin ship id is missing" });
        }   
            paramCount++;
            query += ` AND ship_id = $${paramCount}`;
            queryParams.push(ship_id);
        
        } 
        else if (roleId !== 1) {
        return res.status(403).json({ message: "Forbidden role." });
        }
        const result = await db.query(query, queryParams);

        if (result.rows.length === 0) {
        return res.status(404).json({
            message: "Matrix not found or permission denied to view this user.",
            data: null
        });
        }

        return res.status(200).json({
        message: "User competency matrix fetched successfully",
        data: result.rows[0]
        });
    } catch (error) {
        console.error("getUserCompetencyMatrixById error:", error);
    return res.status(500).json({ message: "Server error", error: error.message });
    }
}


//get all competancy matrix: filtered based on the role
export async function getAllCompetancyMatrices(req,res) {
    try {
        const roleId = getRoleId(req);
        const { company_id: scopedCompanyId, ship_id: scopedShipId } = getFetchScope(req);

        const requestedShipId = req.query.ship_id;
        let finalShipId = null;
        if (roleId === 3) {
            
            finalShipId = scopedShipId;
        } else {
            finalShipId = requestedShipId || null;
        }
        let query = `
            SELECT 
                m.*, 
                u.full_name AS name,
                u.rank
            FROM user_competency_matrix m
            JOIN users u ON m.user_id = u.user_id
            WHERE 1=1
        `;
        let queryParams= [];
        let paramsCount=0;

        //role based filtering
        if(roleId ===2 )
        {
            paramsCount++;
            query += ` AND m.company_id= $${paramsCount}`;
            queryParams.push(scopedCompanyId);

        }
        if (finalShipId) {
            paramsCount++;
            query += ` AND m.ship_id = $${paramsCount}`;
            queryParams.push(finalShipId);
        }

        if(![1,2,3].includes(roleId))
        {
            return res.status(403).json({message: "Forbidden role"});
        }

        const result = await db.query(query, queryParams);

        return res.status(200).json({
        message: "Competency matrices fetched successfully",
        data: result.rows
    });
    } catch (error) {
        console.error("getAllCompetencyMatrices error:", error);
        return res.status(500).json({ message: "Server error", error: error.message });
    }
}




// ==============================================================================
//  1. EXECUTIVE DASHBOARD 
// ==============================================================================
export async function getExecutiveDashboard(req, res) {
    try {
        const { company_id, ship_id } = getFetchScope(req);
        const roleId = getRoleId(req);

        // UPDATE: Cleaned up the math using the new readiness_score column
        // UPDATE: Adjusted the EXISTS block to match the real 'certificates' table schema
        const overviewQuery = `
            WITH user_scores AS (
                SELECT 
                    u.user_id,
                    COALESCE(m.readiness_score, 0) AS compliance_score,
                    EXISTS (
                        SELECT 1 FROM certificates c 
                        WHERE c.user_id = u.user_id 
                        AND (c.expiry_date < CURRENT_DATE OR c.status = 'Expired' OR c.status = 'Failed')
                    ) AS has_hard_stop
                FROM users u
                LEFT JOIN user_competency_matrix m ON u.user_id = m.user_id
                WHERE (u.company_id = $1 OR $1 IS NULL)
                  AND (u.ship_id = $2 OR $2 IS NULL)
            )
            SELECT 
                COUNT(*) AS total_seafarers,
                COUNT(*) FILTER (WHERE NOT has_hard_stop AND compliance_score >= 80) AS ready,
                COUNT(*) FILTER (WHERE NOT has_hard_stop AND compliance_score BETWEEN 50 AND 79) AS conditionally_ready,
                COUNT(*) FILTER (WHERE has_hard_stop OR compliance_score < 50) AS not_ready
            FROM user_scores;
        `;

        const overviewResult = await db.query(overviewQuery, [company_id, ship_id]);
        const stats = overviewResult.rows[0] || { total_seafarers: 0, ready: 0, conditionally_ready: 0, not_ready: 0 };
        const total = parseInt(stats.total_seafarers, 10) || 0;

        let trendData = [];
        if (roleId <= 2) {
            const trendQuery = `
                SELECT 
                    to_char(month_date, 'Mon') AS month,
                    COALESCE(avg_readiness, 0) AS readiness,
                    COALESCE(avg_completion, 0) AS training_completion
                FROM fleet_readiness_history
                WHERE (company_id = $1 OR $1 IS NULL)
                ORDER BY month_date ASC
                LIMIT 7;
            `;
            const trendResult = await db.query(trendQuery, [company_id]);
            trendData = trendResult.rows;
        }

        return res.status(200).json({
            message: "Executive Dashboard data fetched successfully",
            data: {
                total_seafarers: total,
                ready: { count: parseInt(stats.ready, 10), percentage: total > 0 ? Math.round((parseInt(stats.ready, 10) / total) * 100) : 0 },
                conditionally_ready: { count: parseInt(stats.conditionally_ready, 10) },
                not_ready: { count: parseInt(stats.not_ready, 10) },
                trend: trendData
            }
        });
    } catch (error) {
        return res.status(500).json({ message: "Server error", error: error.message });
    }
}

// ==============================================================================
//  2. VESSEL READINESS BREAKDOWN
// ==============================================================================
export async function getVesselReadinessBreakdown(req, res) {
    try {
        const { company_id, ship_id } = getFetchScope(req);
        const roleId = getRoleId(req);

        if (roleId > 3) {
            return res.status(403).json({ message: "Insufficient permissions to view fleet breakdown." });
        }

        // UPDATE: Replaced the bulky CASE statement with a simple AVG(m.readiness_score)
        const query = `
            SELECT 
                s.ship_id,
                s.ship_name AS vessel,
                COALESCE(s.fleet_name, 'General Fleet') AS fleet,
                COUNT(u.user_id)::int AS crew,
                COALESCE(ROUND(AVG(m.readiness_score), 1), 0) AS readiness
            FROM ships s
            LEFT JOIN users u ON s.ship_id = u.ship_id
            LEFT JOIN user_competency_matrix m ON u.user_id = m.user_id
            WHERE (s.company_id = $1 OR $1 IS NULL)
              AND (s.ship_id = $2 OR $2 IS NULL)
            GROUP BY s.ship_id, s.ship_name, s.fleet_name
            ORDER BY readiness DESC;
        `;

        const result = await db.query(query, [company_id, ship_id]);
        return res.status(200).json({ data: result.rows });
    } catch (error) {
        return res.status(500).json({ message: "Server error", error: error.message });
    }
}

// ==============================================================================
//  3. USER CLEARANCE STATUS 
// ==============================================================================
export async function getUserClearanceStatus(req, res) {
    try {
        const requestedUserId = Number(req.params.user_id);
        const { company_id, ship_id } = getFetchScope(req);
        const roleId = getRoleId(req);
        const authUserId = Number(req.user?.user_id);

        if (roleId === 4 && requestedUserId !== authUserId) {
            return res.status(403).json({ message: "Access denied. You can only view your own clearance status." });
        }

        const userQuery = `
            SELECT u.user_id, u.full_name, u.rank, s.ship_name, u.company_id, u.ship_id
            FROM users u
            LEFT JOIN ships s ON u.ship_id = s.ship_id
            WHERE u.user_id = $1;
        `;
        const userRes = await db.query(userQuery, [requestedUserId]);
        if (userRes.rows.length === 0) return res.status(404).json({ message: "Seafarer not found" });
        
        const user = userRes.rows[0];

        if (company_id !== null && user.company_id !== company_id) {
            return res.status(403).json({ message: "Access denied. User belongs to a different company." });
        }
        if (ship_id !== null && user.ship_id !== ship_id) {
            return res.status(403).json({ message: "Access denied. User belongs to a different ship." });
        }

        // UPDATE: Fetch the pre-calculated readiness_score directly
        const matrixQuery = `SELECT * FROM user_competency_matrix WHERE user_id = $1;`;
        const matrixRes = await db.query(matrixQuery, [requestedUserId]);
        const matrix = matrixRes.rows[0] || {};
        
        const complianceScore = parseFloat(matrix.readiness_score) || 0;

        // Fetch Certificates for Hard Stop check
        const certsQuery = `SELECT * FROM certificates WHERE user_id = $1;`;
        const certsRes = await db.query(certsQuery, [requestedUserId]);
        const hasFailedCert = certsRes.rows.some(c => new Date(c.expiry_date) < new Date() || c.status === 'Expired' || c.status === 'Failed');

        let clearanceStatus = "Ready";
        if (hasFailedCert || complianceScore < 50) clearanceStatus = "Not Ready";
        else if (complianceScore < 80) clearanceStatus = "Conditionally Ready";

        return res.status(200).json({
            data: {
                user_id: user.user_id,
                name: user.full_name,
                rank: user.rank,
                vessel: user.ship_name,
                clearance_status: clearanceStatus,
                compliance_score: complianceScore,
                hard_stop_applied: hasFailedCert
            }
        });
    } catch (error) {
        return res.status(500).json({ message: "Server error", error: error.message });
    }
}

// ==============================================================================
//  4. FILTERED SEAFARERS LIST (For clicking "View seafarers ->" on dashboard)
// ==============================================================================
export async function getSeafarersByStatus(req, res) {
    try {
        const { company_id, ship_id } = getFetchScope(req);
        const { status } = req.query; // 'ready', 'conditionally_ready', 'not_ready'

        const query = `
            WITH calculated_users AS (
                SELECT 
                    u.user_id,
                    u.full_name AS name,
                    u.rank,
                    s.ship_name AS vessel,
                    COALESCE(m.readiness_score, 0) AS compliance_score,
                    EXISTS (
                        SELECT 1 FROM certificates c 
                        WHERE c.user_id = u.user_id 
                        AND (c.expiry_date < CURRENT_DATE OR c.status = 'Expired' OR c.status = 'Failed')
                    ) AS has_hard_stop
                FROM users u
                LEFT JOIN ships s ON u.ship_id = s.ship_id
                LEFT JOIN user_competency_matrix m ON u.user_id = m.user_id
                WHERE (u.company_id = $1 OR $1 IS NULL)
                  AND (u.ship_id = $2 OR $2 IS NULL)
            )
            SELECT 
                user_id,
                name,
                rank,
                vessel,
                compliance_score,
                CASE 
                    WHEN has_hard_stop OR compliance_score < 50 THEN 'not_ready'
                    WHEN compliance_score BETWEEN 50 AND 79 THEN 'conditionally_ready'
                    ELSE 'ready'
                END AS calculated_status
            FROM calculated_users
            WHERE 
                ($3::text IS NULL) OR 
                (
                    CASE 
                        WHEN has_hard_stop OR compliance_score < 50 THEN 'not_ready'
                        WHEN compliance_score BETWEEN 50 AND 79 THEN 'conditionally_ready'
                        ELSE 'ready'
                    END = $3
                )
            ORDER BY compliance_score ASC;
        `;

        const result = await db.query(query, [company_id, ship_id, status || null]);

        return res.status(200).json({
            message: "Filtered seafarer list fetched successfully",
            count: result.rows.length,
            data: result.rows
        });
    } catch (error) {
        console.error("getSeafarersByStatus error:", error);
        return res.status(500).json({ message: "Server error", error: error.message });
    }
}