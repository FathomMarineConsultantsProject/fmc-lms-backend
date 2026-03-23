// src/controller/companyController.js
import { db } from "../db.js";
import crypto from "crypto";

const ROLE_SUPERADMIN = 1;
const ROLE_ADMIN = 2;

const isUuid = (v) =>
  typeof v === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);

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
  // ✅ validate UUID always (prevents bad queries + weird comparisons)
  if (!isUuid(String(companyId || "").trim())) {
    res.status(400).json({ error: "company_id must be a valid UUID" });
    return false;
  }

  if (isRole(req, ROLE_SUPERADMIN)) return true;

  if (!req.user?.company_id || String(req.user.company_id) !== String(companyId)) {
    res.status(403).json({ error: "Forbidden (company scope)" });
    return false;
  }
  return true;
};

// ✅ sha256 hash (must match authController login)
const hashPassword = (plain) =>
  crypto.createHash("sha256").update(String(plain)).digest("hex");

// ✅ AES-256-GCM reversible encryption helpers
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

  return `${iv.toString("base64")}.${tag.toString("base64")}.${ciphertext.toString("base64")}`;
};

const decryptPassword = (enc) => {
  try {
    if (!enc) return null;
    const parts = String(enc).split(".");
    if (parts.length !== 3) return null;

    const [ivB64, tagB64, ctB64] = parts;
    const key = getEncKey();

    const iv = Buffer.from(ivB64, "base64");
    const tag = Buffer.from(tagB64, "base64");
    const ciphertext = Buffer.from(ctB64, "base64");

    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);

    const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return plain.toString("utf8");
  } catch {
    return null;
  }
};

// ✅ Make username unique in users table
const makeUniqueUsername = async (base) => {
  const clean = String(base || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "");

  if (!clean) return null;

  const check1 = await db.query("SELECT 1 FROM users WHERE username = $1 LIMIT 1", [clean]);
  if (check1.rows.length === 0) return clean;

  for (let i = 0; i < 5; i++) {
    const candidate = `${clean}.${crypto.randomBytes(2).toString("hex")}`;
    const check = await db.query("SELECT 1 FROM users WHERE username = $1 LIMIT 1", [candidate]);
    if (check.rows.length === 0) return candidate;
  }

  throw new Error("Failed to generate unique username for company admin");
};

// -------------------- GET /companies --------------------
// role1 -> all (with admin password) + pagination
// others -> only their company (NO password)
export const getAllCompanies = async (req, res) => {
  try {
    const roleId = Number(req.user?.role_id);

    // pagination: min 50 max 100
    const pageRaw = Number.parseInt(String(req.query?.page ?? "1"), 10);
    const limitRaw = Number.parseInt(String(req.query?.limit ?? "50"), 10);

    const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
    const limit = Math.min(100, Math.max(50, Number.isFinite(limitRaw) ? limitRaw : 50));
    const offset = (page - 1) * limit;

    // optional search
    const q = String(req.query?.q ?? "").trim();
    const qLike = `%${q}%`;

    // ---------------- SUPERADMIN (role 1) ----------------
    if (roleId === ROLE_SUPERADMIN) {
      const totalRes = await db.query(
        `
        SELECT COUNT(*)::int AS total
        FROM company c
        WHERE ($1 = '' OR c.company_name ILIKE $2 OR c.code ILIKE $2)
        `,
        [q, qLike]
      );
      const total = totalRes.rows[0]?.total ?? 0;

      const { rows } = await db.query(
        `
        SELECT
          c.*,
          u.username AS admin_username,
          u.password_enc AS admin_password_enc
        FROM company c
        LEFT JOIN users u
          ON u.company_id = c.company_id
         AND u.role_id = 2
         AND u.ship_id IS NULL
        WHERE ($1 = '' OR c.company_name ILIKE $2 OR c.code ILIKE $2)
        ORDER BY c.company_id
        LIMIT $3 OFFSET $4
        `,
        [q, qLike, limit, offset]
      );

      const out = rows.map((r) => {
        const { admin_password_enc, ...rest } = r;
        return {
          ...rest,
          admin_password: decryptPassword(admin_password_enc),
        };
      });

      return res.json({
        page,
        limit,
        total,
        count: out.length,
        rows: out,
        applied_filters: { q: q || null },
      });
    }

    // ---------------- NON-SUPERADMIN ----------------
    if (!req.user?.company_id) {
      return res.json({ page: 1, limit: 50, total: 0, count: 0, rows: [] });
    }

    // ✅ validate token company_id just in case
    const myCompanyId = String(req.user.company_id);
    if (!isUuid(myCompanyId)) {
      return res.status(400).json({ error: "Invalid company_id in token (must be UUID)" });
    }

    const { rows } = await db.query("SELECT * FROM company WHERE company_id = $1", [myCompanyId]);

    return res.json({
      page: 1,
      limit: 50,
      total: rows.length,
      count: rows.length,
      rows,
      applied_filters: { q: null },
    });
  } catch (err) {
    console.error("Error getting companies:", err);
    return res.status(500).json({ error: "Failed to fetch companies" });
  }
};

// -------------------- GET /companies/:id --------------------
export const getCompanyById = async (req, res) => {
  const id = String(req.params.id || "").trim();

  // ✅ UUID validation
  if (!isUuid(id)) {
    return res.status(400).json({ error: "company_id must be a valid UUID" });
  }

  try {
    if (!ensureCompanyScope(req, res, id)) return;

    if (isRole(req, ROLE_SUPERADMIN)) {
      const { rows } = await db.query(
        `
        SELECT
          c.*,
          u.username AS admin_username,
          u.password_enc AS admin_password_enc
        FROM company c
        LEFT JOIN users u
          ON u.company_id = c.company_id
         AND u.role_id = 2
         AND u.ship_id IS NULL
        WHERE c.company_id = $1
        LIMIT 1
        `,
        [id]
      );

      if (!rows.length) return res.status(404).json({ error: "Company not found" });

      const row = rows[0];
      const plain = decryptPassword(row.admin_password_enc);
      delete row.admin_password_enc;

      return res.json({ ...row, admin_password: plain });
    }

    const { rows } = await db.query("SELECT * FROM company WHERE company_id = $1", [id]);
    if (!rows.length) return res.status(404).json({ error: "Company not found" });

    return res.json(rows[0]);
  } catch (err) {
    console.error("Error getting company:", err);
    return res.status(500).json({ error: "Failed to fetch company" });
  }
};

// -------------------- POST /companies (role1 only) --------------------
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
    password,
  } = req.body;

  if (!company_name) return res.status(400).json({ error: "company_name is required" });
  if (!username || !password) {
    return res
      .status(400)
      .json({ error: "username and password are required for company admin login" });
  }

  try {
    const existingCompany = await db.query("SELECT 1 FROM company WHERE username = $1 LIMIT 1", [
      String(username).trim(),
    ]);
    if (existingCompany.rows.length) {
      return res.status(409).json({ error: "Company username already exists" });
    }

    await db.query("BEGIN");

    const uniqueUsername = await makeUniqueUsername(username);

    const password_hash = hashPassword(password);
    const password_enc = encryptPassword(password);

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
        uniqueUsername,
        password_hash,
      ]
    );

    const company = rows[0];

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

    return res.status(201).json({
      ...company,
      admin_user_created: true,
      admin_username: uniqueUsername,
      admin_password: password,
    });
  } catch (err) {
    await db.query("ROLLBACK");
    console.error("Error creating company:", err);
    return res.status(500).json({ error: "Failed to create company" });
  }
};

// -------------------- PUT /companies/:id --------------------
export const updateCompany = async (req, res) => {
  const id = String(req.params.id || "").trim();

  // ✅ UUID validation
  if (!isUuid(id)) {
    return res.status(400).json({ error: "company_id must be a valid UUID" });
  }

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
    password,
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

    // Sync company admin user
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

// -------------------- DELETE /companies/:id (role1 only) --------------------
export const deleteCompany = async (req, res) => {
  const id = String(req.params.id || "").trim();

  // ✅ UUID validation
  if (!isUuid(id)) {
    return res.status(400).json({ error: "company_id must be a valid UUID" });
  }

  if (!ensureRole(req, res, [ROLE_SUPERADMIN])) return;

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


// GET /companies/options
export const getCompanyOptions = async (req, res) => {
  try {
    const roleId = Number(req.user?.role_id);

    // superadmin -> all companies
    if (roleId === ROLE_SUPERADMIN) {
      const { rows } = await db.query(
        `
        SELECT company_id, company_name
        FROM company
        ORDER BY company_name ASC
        `
      );

      return res.json({
        rows,
      });
    }

    // admin/subadmin/crew -> only their own company
    const myCompanyId = req.user?.company_id ? String(req.user.company_id) : null;

    if (!myCompanyId || !isUuid(myCompanyId)) {
      return res.json({ rows: [] });
    }

    const { rows } = await db.query(
      `
      SELECT company_id, company_name
      FROM company
      WHERE company_id = $1
      ORDER BY company_name ASC
      `,
      [myCompanyId]
    );

    return res.json({
      rows,
    });
  } catch (err) {
    console.error("Error getting company options:", err);
    return res.status(500).json({ error: "Failed to fetch company options" });
  }
};