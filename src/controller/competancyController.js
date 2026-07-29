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
        if (!shipId) {
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
        const {company_id, ship_id} = getFetchScope(req);

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
        if(roleId ===2 || (roleId===1 && company_id))
        {
            paramsCount++;
            query += ` AND company_id= $${paramsCount}`;
            queryParams.push(company_id);

        }
        if(roleId ===3 || (roleId===2 && ship_id))
        {
            paramsCount++;
            query+=` AND ship_id=$${paramsCount}`
            queryParams.push(ship_id);
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