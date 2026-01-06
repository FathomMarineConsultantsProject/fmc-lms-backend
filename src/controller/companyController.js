// src/controller/companyController.js
import { db } from "../db.js";
import crypto from "crypto";

const ROLE_SUPERADMIN = 1;
const ROLE_ADMIN = 2;

const isRole = (req, roleId) => Number(req.user?.role_id) === Number(roleId);

const ensureRole = (req, res, allowedRoles) => {
  const roleId = Number(req.user?.role_id);
  if (!roleId || !allowedRoles.includes(roleId)) {
    res.status(403).json({ error: "Forbidden" });
    return false;
  }
  return true;
};

const ensureCompanyScope = (req, res, companyId) => {
  if (isRole(req, ROLE_SUPERADMIN)) return true;

  if (!req.user?.company_id || String(req.user.company_id) !== String(companyId)) {
    res.status(403).json({ error: "Forbidden (company scope)" });
    return false;
  }
  return true;
};

// ✅ must match your auth/login hashing logic (you use sha256)
const hashPassword = (plain) =>
  crypto.createHash("sha256").update(String(plain)).digest("hex");

// ✅ AES-256-GCM reversible encryption (same format as auth/usersController)
const getEncKey = () => {
  const b64 = process.env.PASSWORD_ENC_KEY;
  if (!b64) throw new Error("PASSWORD_ENC_KEY missing in .env");
  const key = Buffer.from(b64, "base64");
  if (key.length !== 32) throw new Error("PASSWORD_ENC_KEY must be 32 bytes base64");
  return key;
};

const encryptPassword = (plain) => {
  const key = getEncKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);

  const ciphertext = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  // base64(iv).base64(tag).base64(ciphertext)
  return `${iv.toString("base64")}.${tag.toString("base64")}.${ciphertext.toString("base64")}`;
};

// ✅ Make username unique in users table
const makeUniqueUsername = async (base) => {
  const clean = String(base || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "");

  if (!clean) return null;

  // try base first
  const check1 = await db.query("SELECT 1 FROM users WHERE username = $1 LIMIT 1", [clean]);
  if (check1.rows.length === 0) return clean;

  // add suffix if collision
  for (let i = 0; i < 5; i++) {
    const candidate = `${clean}.${crypto.randomBytes(2).toString("hex")}`;
    const check = await db.query("SELECT 1 FROM users WHERE username = $1 LIMIT 1", [candidate]);
    if (check.rows.length === 0) return candidate;
  }

  throw new Error("Failed to generate unique username for company admin");
};

// GET /companies
export const getAllCompanies = async (req, res) => {
  try {
    if (isRole(req, ROLE_SUPERADMIN)) {
      const { rows } = await db.query("SELECT * FROM company ORDER BY company_id");
      return res.json(rows);
    }

    if (!req.user?.company_id) return res.json([]);

    const { rows } = await db.query("SELECT * FROM company WHERE company_id = $1", [
      req.user.company_id,
    ]);
    return res.json(rows);
  } catch (err) {
    console.error("Error getting companies:", err);
    return res.status(500).json({ error: "Failed to fetch companies" });
  }
};

// GET /companies/:id
export const getCompanyById = async (req, res) => {
  const id = String(req.params.id);

  try {
    if (!ensureCompanyScope(req, res, id)) return;

    const { rows } = await db.query("SELECT * FROM company WHERE company_id = $1", [id]);
    if (!rows.length) return res.status(404).json({ error: "Company not found" });

    return res.json(rows[0]);
  } catch (err) {
    console.error("Error getting company:", err);
    return res.status(500).json({ error: "Failed to fetch company" });
  }
};

// POST /companies (role1 only)
// ✅ Creates company + creates a users row for company admin (role_id=2)
// ✅ Accepts plain password in req.body.password
// ✅ Stores password_enc in users so SuperAdmin can view via adminViewPassword / users list
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
    password, // ✅ PLAIN password
  } = req.body;

  if (!company_name) return res.status(400).json({ error: "company_name is required" });

  if (!username || !password) {
    return res.status(400).json({ error: "username and password are required for company admin login" });
  }

  try {
    // prevent duplicate company.username
    const existingCompany = await db.query("SELECT 1 FROM company WHERE username = $1 LIMIT 1", [
      String(username).trim(),
    ]);
    if (existingCompany.rows.length) {
      return res.status(409).json({ error: "Company username already exists" });
    }

    await db.query("BEGIN");

    // ensure unique in users as well (avoid collision with crew)
    const uniqueUsername = await makeUniqueUsername(username);

    const password_hash = hashPassword(password);
    const password_enc = encryptPassword(password);

    // 1) create company
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
        uniqueUsername, // ✅ synced with users username
        password_hash,
      ]
    );

    const company = rows[0];

    // 2) create user row for company admin (role_id=2)
    await db.query(
      `INSERT INTO users
       (seafarer_id, full_name, username, password_hash, password_enc,
        company_id, ship_id, role_id,
        status, created_at, updated_at, email)
       VALUES
       ($1, $2, $3, $4, $5,
        $6, NULL, 2,
        'Onboard', NOW(), NOW(), $7)`,
      [
        `COMPANY:${company.company_id}`,
        `${company.company_name} Admin`,
        uniqueUsername,
        password_hash,
        password_enc,
        company.company_id,
        email ?? null,
      ]
    );

    await db.query("COMMIT");

    // ⚠️ returning plain password is optional; helps you test quickly
    return res.status(201).json({
      ...company,
      admin_user_created: true,
      admin_username: uniqueUsername,
      admin_password: password, // remove in production if you don’t want to expose it
    });
  } catch (err) {
    await db.query("ROLLBACK");
    console.error("Error creating company:", err);
    return res.status(500).json({ error: "Failed to create company" });
  }
};

// PUT /companies/:id
export const updateCompany = async (req, res) => {
  const id = String(req.params.id);

  if (!ensureRole(req, res, [ROLE_SUPERADMIN, ROLE_ADMIN])) return;
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
    password, // ✅ plain password allowed on update too
  } = req.body;

  try {
    let newUsername = username ?? null;
    if (username) newUsername = await makeUniqueUsername(username);

    const newPasswordHash = password ? hashPassword(password) : null;
    const newPasswordEnc = password ? encryptPassword(password) : null;

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
        newUsername,
        newPasswordHash,
        id,
      ]
    );

    if (!rowCount) return res.status(404).json({ error: "Company not found" });

    // Sync company admin user in users table
    if (newUsername || newPasswordHash || newPasswordEnc || email || company_name) {
      await db.query(
        `UPDATE users
         SET
           username = COALESCE($1, username),
           password_hash = COALESCE($2, password_hash),
           password_enc = COALESCE($3, password_enc),
           email = COALESCE($4, email),
           full_name = COALESCE($5, full_name),
           status = 'Onboard',
           updated_at = NOW()
         WHERE company_id = $6 AND role_id = 2 AND ship_id IS NULL`,
        [
          newUsername,
          newPasswordHash,
          newPasswordEnc,
          email ?? null,
          company_name ? `${company_name} Admin` : null,
          id,
        ]
      );
    }

    return res.json({ message: "Company updated", username: newUsername ?? undefined });
  } catch (err) {
    console.error("Error updating company:", err);
    return res.status(500).json({ error: "Failed to update company" });
  }
};

// DELETE /companies/:id (role1 only)
export const deleteCompany = async (req, res) => {
  if (!ensureRole(req, res, [ROLE_SUPERADMIN])) return;

  const id = String(req.params.id);

  try {
    await db.query("BEGIN");

    await db.query("DELETE FROM users WHERE company_id = $1 AND role_id = 2 AND ship_id IS NULL", [
      id,
    ]);

    const { rowCount } = await db.query("DELETE FROM company WHERE company_id = $1", [id]);
    if (!rowCount) {
      await db.query("ROLLBACK");
      return res.status(404).json({ error: "Company not found" });
    }

    await db.query("COMMIT");
    return res.json({ message: "Company deleted" });
  } catch (err) {
    await db.query("ROLLBACK");
    console.error("Error deleting company:", err);
    return res.status(500).json({ error: "Failed to delete company" });
  }
};
