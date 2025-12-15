// src/controller/companyController.js
import { db } from '../db.js';

// GET /companies
export const getAllCompanies = async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT * FROM company ORDER BY company_id'
    );
    res.json(rows);
  } catch (err) {
    console.error('Error getting companies:', err);
    res.status(500).json({ error: 'Failed to fetch companies' });
  }
};

// GET /companies/:id
export const getCompanyById = async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT * FROM company WHERE company_id = $1',
      [req.params.id]
    );

    if (!rows.length) {
      return res.status(404).json({ error: 'Company not found' });
    }

    res.json(rows[0]);
  } catch (err) {
    console.error('Error getting company:', err);
    res.status(500).json({ error: 'Failed to fetch company' });
  }
};

// POST /companies
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

  if (!company_name) {
    return res.status(400).json({ error: 'company_name is required' });
  }

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
        code || null,
        email_domain || null,
        is_active,
        metadata_json || null,
        ships_count || null,
        role || null,
        regional_address || null,
        ism_address || null,
        type || null,
        contact_person_name || null,
        phone_no || null,
        email || null,
        username || null,
        password_hash || null,
      ]
    );

    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('Error creating company:', err);
    res.status(500).json({ error: 'Failed to create company' });
  }
};

// PUT /companies/:id
export const updateCompany = async (req, res) => {
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
        req.params.id,
      ]
    );

    if (!rowCount) {
      return res.status(404).json({ error: 'Company not found' });
    }

    res.json({ message: 'Company updated' });
  } catch (err) {
    console.error('Error updating company:', err);
    res.status(500).json({ error: 'Failed to update company' });
  }
};

// DELETE /companies/:id
export const deleteCompany = async (req, res) => {
  try {
    const { rowCount } = await db.query(
      'DELETE FROM company WHERE company_id = $1',
      [req.params.id]
    );

    if (!rowCount) {
      return res.status(404).json({ error: 'Company not found' });
    }

    res.json({ message: 'Company deleted' });
  } catch (err) {
    console.error('Error deleting company:', err);
    res.status(500).json({ error: 'Failed to delete company' });
  }
};
