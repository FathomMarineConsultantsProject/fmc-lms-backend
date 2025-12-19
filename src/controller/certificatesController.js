import { db } from '../db.js';

const ROLE_SUPERADMIN = 1;
const ROLE_ADMIN = 2;
const ROLE_SUBADMIN = 3;
const ROLE_CREW = 4;

const CERT_STATUS = ['valid', 'expired', 'expiring_soon'];

const certScope = (req) => {
    const role = req.user.role_id;

    if (role === ROLE_SUPERADMIN) return { where: 'TRUE', params: [] };
    if (role === ROLE_ADMIN) return { where: 'company_id = $1', params: [req.user.company_id] };
    if (role === ROLE_SUBADMIN)
        return {
            where: 'company_id = $1 AND ship_id = $2',
            params: [req.user.company_id, req.user.ship_id],
        };

    // role4: own certs only
    return { where: 'user_id = $1', params: [req.user.user_id] };
};

const canWrite = (roleId) => [ROLE_SUPERADMIN, ROLE_ADMIN, ROLE_SUBADMIN].includes(roleId);

// GET /certificates
export const getAllCertificates = async (req, res) => {
    try {
        const { where, params } = certScope(req);
        const { rows } = await db.query(
            `SELECT *
       FROM certificates
       WHERE ${where}
       ORDER BY created_at DESC, certificate_id DESC`,
            params
        );
        res.json(rows);
    } catch (err) {
        console.error('Error getting certificates:', err);
        res.status(500).json({ error: 'Failed to fetch certificates' });
    }
};

// GET /certificates/:id
export const getCertificateById = async (req, res) => {
    try {
        const { where, params } = certScope(req);
        const { rows } = await db.query(
            `SELECT *
       FROM certificates
       WHERE certificate_id = $1 AND (${where})`,
            [parseInt(req.params.id, 10), ...params]
        );
        if (!rows.length) return res.status(404).json({ error: 'Certificate not found' });
        res.json(rows[0]);
    } catch (err) {
        console.error('Error getting certificate:', err);
        res.status(500).json({ error: 'Failed to fetch certificate' });
    }
};

// POST /certificates
export const createCertificate = async (req, res) => {
    if (!canWrite(req.user.role_id)) return res.status(403).json({ error: 'Forbidden' });

    const {
        user_id,
        company_id,
        ship_id,
        full_name,
        company_name,
        title,
        certificate_name,
        certificate_number,
        issued_by,
        grade,
        issue_date,
        expiry_date,
        status,
        file_url,
    } = req.body;

    if (!user_id || !company_id) {
        return res.status(400).json({ error: 'user_id and company_id are required' });
    }

    // enforce scope for role2/3
    if (req.user.role_id === ROLE_ADMIN && String(company_id) !== String(req.user.company_id)) {
        return res.status(403).json({ error: 'Forbidden (company scope)' });
    }
    if (req.user.role_id === ROLE_SUBADMIN) {
        if (String(company_id) !== String(req.user.company_id) || Number(ship_id) !== Number(req.user.ship_id)) {
            return res.status(403).json({ error: 'Forbidden (ship scope)' });
        }
    }

    if (status && !CERT_STATUS.includes(String(status))) {
        return res.status(400).json({
            error: `Invalid status. Allowed values: ${CERT_STATUS.join(', ')}`
        });
    }

    try {
        const { rows } = await db.query(
            `INSERT INTO certificates (
        user_id, company_id, ship_id, full_name, company_name, title,
        certificate_name, certificate_number, issued_by, grade,
        issue_date, expiry_date, status, file_url, created_at, updated_at
      )
      VALUES (
        $1,$2,$3,$4,$5,$6,
        $7,$8,$9,$10,
        $11,$12,$13,$14,
        NOW(), NOW()
      )
      RETURNING *`,
            [
                parseInt(user_id, 10),
                String(company_id),
                ship_id != null ? parseInt(ship_id, 10) : null,
                full_name || null,
                company_name || null,
                title || null,
                certificate_name || null,
                certificate_number || null,
                issued_by || null,
                grade || null,
                issue_date || null,
                expiry_date || null,
                status || null,
                file_url || null,
            ]
        );
        res.status(201).json(rows[0]);
    } catch (err) {
        console.error('Error creating certificate:', err);
        res.status(500).json({ error: 'Failed to create certificate' });
    }
};

// PUT /certificates/:id
export const updateCertificate = async (req, res) => {
    if (!canWrite(req.user.role_id)) return res.status(403).json({ error: 'Forbidden' });

    try {
        // first, ensure target is in scope
        const { where, params } = certScope(req);
        const id = parseInt(req.params.id, 10);

        const found = await db.query(
            `SELECT certificate_id, company_id, ship_id
       FROM certificates
       WHERE certificate_id = $1 AND (${where})`,
            [id, ...params]
        );
        if (!found.rows.length) return res.status(404).json({ error: 'Certificate not found' });

        const {
            user_id,
            company_id,
            ship_id,
            full_name,
            company_name,
            title,
            certificate_name,
            certificate_number,
            issued_by,
            grade,
            issue_date,
            expiry_date,
            status,
            file_url,
        } = req.body;

        // if role2/3 tries to change company/ship outside scope -> block
        if (req.user.role_id === ROLE_ADMIN && company_id && String(company_id) !== String(req.user.company_id)) {
            return res.status(403).json({ error: 'Forbidden (company scope)' });
        }
        if (req.user.role_id === ROLE_SUBADMIN) {
            if ((company_id && String(company_id) !== String(req.user.company_id)) ||
                (ship_id && Number(ship_id) !== Number(req.user.ship_id))) {
                return res.status(403).json({ error: 'Forbidden (ship scope)' });
            }
        }

        if (status && !CERT_STATUS.includes(String(status))) {
            return res.status(400).json({
                error: `Invalid status. Allowed values: ${CERT_STATUS.join(', ')}`
            });
        }

        const { rowCount } = await db.query(
            `UPDATE certificates SET
        user_id             = COALESCE($1, user_id),
        company_id          = COALESCE($2, company_id),
        ship_id             = COALESCE($3, ship_id),
        full_name           = COALESCE($4, full_name),
        company_name        = COALESCE($5, company_name),
        title               = COALESCE($6, title),
        certificate_name    = COALESCE($7, certificate_name),
        certificate_number  = COALESCE($8, certificate_number),
        issued_by           = COALESCE($9, issued_by),
        grade               = COALESCE($10, grade),
        issue_date          = COALESCE($11, issue_date),
        expiry_date         = COALESCE($12, expiry_date),
        status              = COALESCE($13, status),
        file_url            = COALESCE($14, file_url),
        updated_at          = NOW()
      WHERE certificate_id = $15`,
            [
                user_id ?? null,
                company_id ?? null,
                ship_id ?? null,
                full_name ?? null,
                company_name ?? null,
                title ?? null,
                certificate_name ?? null,
                certificate_number ?? null,
                issued_by ?? null,
                grade ?? null,
                issue_date ?? null,
                expiry_date ?? null,
                status ?? null,
                file_url ?? null,
                id,
            ]
        );

        if (!rowCount) return res.status(404).json({ error: 'Certificate not found' });
        res.json({ message: 'Certificate updated' });
    } catch (err) {
        console.error('Error updating certificate:', err);
        res.status(500).json({ error: 'Failed to update certificate' });
    }
};

// DELETE /certificates/:id
export const deleteCertificate = async (req, res) => {
    if (!canWrite(req.user.role_id)) return res.status(403).json({ error: 'Forbidden' });

    try {
        // ensure in scope
        const { where, params } = certScope(req);
        const id = parseInt(req.params.id, 10);

        const { rowCount } = await db.query(
            `DELETE FROM certificates
       WHERE certificate_id = $1 AND (${where})`,
            [id, ...params]
        );

        if (!rowCount) return res.status(404).json({ error: 'Certificate not found' });
        res.json({ message: 'Certificate deleted' });
    } catch (err) {
        console.error('Error deleting certificate:', err);
        res.status(500).json({ error: 'Failed to delete certificate' });
    }
};
