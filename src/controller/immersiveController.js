import { db } from "../db.js";
// ==========================================
// SCENARIOS CONTROLLERS
// ==========================================

export const getAllScenarios = async (req, res) => {
    try {
        const result = await db.query(
            `SELECT * FROM immersive_scenarios 
             WHERE deleted_at IS NULL 
             ORDER BY created_at DESC`
        );
        res.status(200).json({ scenarios: result.rows });
    } catch (error) {
        console.error('Error fetching scenarios:', error);
        res.status(500).json({ error: 'Failed to fetch scenarios' });
    }
};

export const createScenario = async (req, res) => {
    const { 
        title, description, difficulty, duration_minutes, 
        roles_count, weather, time_of_day, learning_objectives 
    } = req.body;
    
    // Safely extract the user_id from the token payload (req.user)
    const created_by = req.user?.user_id || req.user?.id || null; 

    try {
        const result = await db.query(
            `INSERT INTO immersive_scenarios 
            (title, description, difficulty, duration_minutes, roles_count, weather, time_of_day, learning_objectives, created_by) 
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) 
            RETURNING *`,
            [
                title, 
                description, 
                difficulty || 'medium', 
                parseInt(duration_minutes, 10) || 0, 
                parseInt(roles_count, 10) || 1, 
                weather, 
                time_of_day, 
                JSON.stringify(learning_objectives || []), 
                created_by
            ]
        );
        res.status(201).json({ message: 'Scenario created', scenario: result.rows[0] });
    } catch (error) {
        console.error('Error creating scenario:', error);
        res.status(500).json({ error: 'Failed to create scenario' });
    }
};

export const updateScenario = async (req, res) => {
    const { id } = req.params;
    const { title, description, difficulty, duration_minutes, roles_count, weather, time_of_day, learning_objectives } = req.body;

    try {
        const result = await db.query(
            `UPDATE immersive_scenarios 
             SET title = COALESCE($1, title),
                 description = COALESCE($2, description),
                 difficulty = COALESCE($3, difficulty),
                 duration_minutes = COALESCE($4, duration_minutes),
                 roles_count = COALESCE($5, roles_count),
                 weather = COALESCE($6, weather),
                 time_of_day = COALESCE($7, time_of_day),
                 learning_objectives = COALESCE($8, learning_objectives),
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $9 AND deleted_at IS NULL
             RETURNING *`,
            [
                title, 
                description, 
                difficulty, 
                duration_minutes ? parseInt(duration_minutes, 10) : null, 
                roles_count ? parseInt(roles_count, 10) : null, 
                weather, 
                time_of_day, 
                learning_objectives ? JSON.stringify(learning_objectives) : null, 
                id
            ]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Scenario not found' });
        }

        res.status(200).json({ message: 'Scenario updated', scenario: result.rows[0] });
    } catch (error) {
        console.error('Error updating scenario:', error);
        res.status(500).json({ error: 'Failed to update scenario' });
    }
};

// ==========================================
// EQUIPMENT CONTROLLERS
// ==========================================

export const getAllEquipment = async (req, res) => {
    try {
        const result = await db.query(
            `SELECT * FROM immersive_equipment 
             WHERE deleted_at IS NULL 
             ORDER BY created_at DESC`
        );
        res.status(200).json({ equipment: result.rows });
    } catch (error) {
        console.error('Error fetching equipment:', error);
        res.status(500).json({ error: 'Failed to fetch equipment' });
    }
};

export const createEquipment = async (req, res) => {
    const { title, model, type, location, status, specs } = req.body;

    try {
        const result = await db.query(
            `INSERT INTO immersive_equipment 
            (title, model, type, location, status, specs) 
            VALUES ($1, $2, $3, $4, $5, $6) 
            RETURNING *`,
            [
                title, 
                model, 
                type, 
                location, 
                status || 'available', 
                JSON.stringify(specs || [])
            ]
        );
        res.status(201).json({ message: 'Equipment added', equipment: result.rows[0] });
    } catch (error) {
        console.error('Error adding equipment:', error);
        res.status(500).json({ error: 'Failed to add equipment' });
    }
};

export const updateEquipmentStatus = async (req, res) => {
    const { id } = req.params;
    const { status } = req.body; 

    // Validate the ENUM
    if (!['available', 'booked', 'maintenance'].includes(status)) {
        return res.status(400).json({ error: 'Invalid status provided.' });
    }

    try {
        const result = await db.query(
            `UPDATE immersive_equipment 
             SET status = $1, updated_at = CURRENT_TIMESTAMP 
             WHERE id = $2 AND deleted_at IS NULL
             RETURNING *`,
            [status, id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Equipment not found' });
        }

        res.status(200).json({ message: 'Status updated successfully', equipment: result.rows[0] });
    } catch (error) {
        console.error('Error updating equipment status:', error);
        res.status(500).json({ error: 'Failed to update equipment status' });
    }
};

export const updateEquipmentDetails = async (req, res) => {
    const { id } = req.params;
    const { title, model, type, location, specs } = req.body;

    try {
        const result = await db.query(
            `UPDATE immersive_equipment 
             SET title = COALESCE($1, title),
                 model = COALESCE($2, model),
                 type = COALESCE($3, type),
                 location = COALESCE($4, location),
                 specs = COALESCE($5, specs),
                 updated_at = CURRENT_TIMESTAMP 
             WHERE id = $6 AND deleted_at IS NULL
             RETURNING *`,
            [
                title, 
                model, 
                type, 
                location, 
                specs ? JSON.stringify(specs) : null, 
                id
            ]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Equipment not found' });
        }

        res.status(200).json({ message: 'Equipment details updated', equipment: result.rows[0] });
    } catch (error) {
        console.error('Error updating equipment:', error);
        res.status(500).json({ error: 'Failed to update equipment details' });
    }
};

