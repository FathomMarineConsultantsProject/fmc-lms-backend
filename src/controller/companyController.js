// src/controller/companyController.js
import { db } from '../db.js';

const ROLE_SUPERADMIN = 1;
const ROLE_ADMIN = 2;

const isRole = (req, roleId) => Number(req.user?.role_id) === Number(roleId);

const ensureRole = (req, res, allowedRoles) => {
  const roleId = Number(req.user?.role_id);
  if (!roleId || !allowedRoles.includes(roleId)) {
    res.status(403).json({ error: 'Forbidden' });
    return false;
  }
  return true;
};

const ensureCompanyScope = (req, res, companyId) => {
  // role1 can access any company
  if (isRole(req, ROLE_SUPERADMIN)) return true;

  // others must have company_id and must match requested companyId
  if (!req.user?.company_id || String(req.user.company_id) !== String(companyId)) {
    res.status(403).json({ error: 'Forbidden (company scope)' });
    return false;
  }
  return true;
};

// GET /companies
// role1 -> all companies
// role2/3/4 -> only own company
export const getAllCompanies = async (req, res) => {
  try {
    if (isRole(req, ROLE_SUPERADMIN)) {
      const { rows } = await db.query('SELECT * FROM company ORDER BY company_id');
      return res.json(rows);
    }

    if (!req.user?.company_id) return res.json([]);

    const { rows } = await db.query(
      'SELECT * FROM company WHERE company_id = $1',
      [req.user.company_id]
    );
    return res.json(rows);
  } catch (err) {
    console.error('Error getting companies:', err);
    return res.status(500).json({ error: 'Failed to fetch companies' });
  }
};

// GET /companies/:id
// role1 -> any
// role2/3/4 -> only own company
export const getCompanyById = async (req, res) => {
  const id = String(req.params.id);

  try {
    if (!ensureCompanyScope(req, res, id)) return;

    const { rows } = await db.query('SELECT * FROM company WHERE company_id = $1', [id]);
    if (!rows.length) return res.status(404).json({ error: 'Company not found' });

    return res.json(rows[0]);
  } catch (err) {
    console.error('Error getting company:', err);
    return res.status(500).json({ error: 'Failed to fetch company' });
  }
};

// POST /companies  (role1 only)
// Example body:
// {
//   "company_name": "Fathom Marine",
//   "code": "FMC",
//   "email_domain": "xyz.com",
//   "is_active": true,
//   "metadata_json": "{}",
//   "ships_count": 10,
//   "role": "Owner",
//   "regional_address": "Some address",
//   "ism_address": "Some ism address",
//   "type": "Ship Manager",
//   "contact_person_name": "xyz",
//   "phone_no": "1234567890",
//   "email": "info@fathommarine.com",
//   "username": "fmc_admin",
//   "password_hash": "hashed_password_here"
// }
export const createCompany = async (req, res) => {
  if (!ensureRole(req, res, [ROLE_SUPERADMIN])) return;

  const {
    company_name,
    code,
    email_domain,
    is_active,
    metadata_json,
    ships_count,
    role,
    regional_address,
    ism_address,
    type,
    contact_person_name,
    phone_no,
    email,
    username,
    password_hash,
  } = req.body;

  if (!company_name) return res.status(400).json({ error: 'company_name is required' });

  try {
    const { rows } = await db.query(
      `INSERT INTO company
       (company_name, code, email_domain, is_active,
        created_at, updated_at,
        metadata_json, ships_count, role,
        regional_address, ism_address, type,
        contact_person_name, phone_no, email,
        username, password_hash)
       VALUES
       ($1, $2, $3, COALESCE($4, true),
        NOW(), NOW(),
        $5, $6, $7,
        $8, $9, $10,
        $11, $12, $13,
        $14, $15)
       RETURNING *`,
      [
        company_name,
        code ?? null,
        email_domain ?? null,
        is_active,
        metadata_json ?? null,
        ships_count ?? null,
        role ?? null,
        regional_address ?? null,
        ism_address ?? null,
        type ?? null,
        contact_person_name ?? null,
        phone_no ?? null,
        email ?? null,
        username ?? null,
        password_hash ?? null,
      ]
    );

    return res.status(201).json(rows[0]);
  } catch (err) {
    console.error('Error creating company:', err);
    return res.status(500).json({ error: 'Failed to create company' });
  }
};

// PUT /companies/:id
// role1 -> update any
// role2 -> update only own company
export const updateCompany = async (req, res) => {
  const id = String(req.params.id);

  // Only role1/role2 allowed to update
  if (!ensureRole(req, res, [ROLE_SUPERADMIN, ROLE_ADMIN])) return;

  // role2 must match company scope
  if (!ensureCompanyScope(req, res, id)) return;

  const {
    company_name,
    code,
    email_domain,
    is_active,
    metadata_json,
    ships_count,
    role,
    regional_address,
    ism_address,
    type,
    contact_person_name,
    phone_no,
    email,
    username,
    password_hash,
  } = req.body;

  try {
    const { rowCount } = await db.query(
      `UPDATE company
       SET
         company_name        = COALESCE($1, company_name),
         code                = COALESCE($2, code),
         email_domain        = COALESCE($3, email_domain),
         is_active           = COALESCE($4, is_active),
         metadata_json       = COALESCE($5, metadata_json),
         ships_count         = COALESCE($6, ships_count),
         role                = COALESCE($7, role),
         regional_address    = COALESCE($8, regional_address),
         ism_address         = COALESCE($9, ism_address),
         type                = COALESCE($10, type),
         contact_person_name = COALESCE($11, contact_person_name),
         phone_no            = COALESCE($12, phone_no),
         email               = COALESCE($13, email),
         username            = COALESCE($14, username),
         password_hash       = COALESCE($15, password_hash),
         updated_at          = NOW()
       WHERE company_id = $16`,
      [
        company_name ?? null,
        code ?? null,
        email_domain ?? null,
        is_active ?? null,
        metadata_json ?? null,
        ships_count ?? null,
        role ?? null,
        regional_address ?? null,
        ism_address ?? null,
        type ?? null,
        contact_person_name ?? null,
        phone_no ?? null,
        email ?? null,
        username ?? null,
        password_hash ?? null,
        id,
      ]
    );

    if (!rowCount) return res.status(404).json({ error: 'Company not found' });
    return res.json({ message: 'Company updated' });
  } catch (err) {
    console.error('Error updating company:', err);
    return res.status(500).json({ error: 'Failed to update company' });
  }
};

// DELETE /companies/:id  (role1 only)
export const deleteCompany = async (req, res) => {
  if (!ensureRole(req, res, [ROLE_SUPERADMIN])) return;

  try {
    const { rowCount } = await db.query(
      'DELETE FROM company WHERE company_id = $1',
      [req.params.id]
    );

    if (!rowCount) return res.status(404).json({ error: 'Company not found' });
    return res.json({ message: 'Company deleted' });
  } catch (err) {
    console.error('Error deleting company:', err);
    return res.status(500).json({ error: 'Failed to delete company' });
  }
};
