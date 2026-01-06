// src/controller/usersController.js
import { db } from "../db.js";
import crypto from "crypto";
import multer from "multer";
import xlsx from "xlsx";
import { handleShipHistoryChange } from "../utils/shipHistory.js";

// ================= STATUS / PASSWORD HELPERS =================
const normalizeStatus = (s) => (s ? String(s).trim().toLowerCase() : null);
const isOnboard = (s) => normalizeStatus(s) === "onboard";

// ✅ Ship-admin rank detection (role_id=3)
const normalizeRank = (r) =>
  String(r || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");

const isShipAdminRank = (rankValue) => {
  const r = normalizeRank(rankValue);

  // keywords that indicate senior officers / ship admins
  const keywords = [
    "master",
    "captain",
    "chief officer",
    "chief mate",
    "c/o",
    "1st officer",
    "first officer",
    "chief engineer",
    "c/e",
    "1st engineer",
    "first engineer",
  ];

  return keywords.some((k) => r.includes(k));
};


// If Excel doesn't contain status: compute from disembarkation_date
const computeStatusFromDates = ({ disembarkation_date }) => {
  if (!disembarkation_date) return "Onboard";
  return "Offboard";
};

// password generator (readable)
const generatePassword = (length = 12) => {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789@#$";
  let out = "";
  const bytes = crypto.randomBytes(length);
  for (let i = 0; i < length; i++) out += chars[bytes[i] % chars.length];
  return out;
};

// hash password (your current approach)
const hashPassword = (plain) =>
  crypto.createHash("sha256").update(String(plain)).digest("hex");

// AES-256-GCM reversible encryption
const getEncKey = () => {
  const b64 = process.env.PASSWORD_ENC_KEY;
  if (!b64) throw new Error("PASSWORD_ENC_KEY missing in .env");
  const key = Buffer.from(b64, "base64");
  if (key.length !== 32) throw new Error("PASSWORD_ENC_KEY must be 32 bytes base64");
  return key;
};

/**
 * returns: base64(iv).base64(tag).base64(ciphertext)
 */
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
    const [ivB64, tagB64, ctB64] = String(enc).split(".");
    if (!ivB64 || !tagB64 || !ctB64) return null;

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

// generate username based on seafarer_id + random suffix to avoid collisions
const generateUsername = (seafarerId) => {
  const base = String(seafarerId).toLowerCase().replace(/[^a-z0-9]/g, "");
  const suffix = crypto.randomBytes(3).toString("hex"); // 6 chars
  return `${base}.${suffix}`;
};

const MAX_USERNAME_TRIES = 5;

const createUniqueUsername = async (seafarerId) => {
  for (let i = 0; i < MAX_USERNAME_TRIES; i++) {
    const candidate = generateUsername(seafarerId);
    const { rows } = await db.query(`SELECT 1 FROM users WHERE username = $1 LIMIT 1`, [
      candidate,
    ]);
    if (rows.length === 0) return candidate;
  }
  throw new Error("Failed to generate unique username");
};

// ================= GENERAL VALIDATION HELPERS =================
const normalizeKey = (k) =>
  String(k || "")
    .replace(/\s+/g, " ")
    .replace(/[\r\n]+/g, " ")
    .trim()
    .toLowerCase();

const isUuid = (v) =>
  typeof v === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);

const parseIntOrNull = (v) => {
  if (v === null || v === undefined || String(v).trim() === "") return null;
  const n = Number.parseInt(String(v), 10);
  return Number.isNaN(n) ? NaN : n;
};

const parseDateOrNull = (v) => {
  if (v === null || v === undefined || String(v).trim() === "") return null;

  // Excel may pass Date objects or strings
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return NaN;
    return v.toISOString().slice(0, 10);
  }

  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) return NaN;
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
};

// If role is allowed, attach plaintext password via decrypt(password_enc)
const canSeePlainPassword = (roleId) => [1, 2, 3].includes(Number(roleId));

const attachPlainPasswordIfAllowed = (roleId, userRow) => {
  if (!canSeePlainPassword(roleId)) return userRow;
  const plain = decryptPassword(userRow.password_enc);
  return {
    ...userRow,
    plain_password: plain, // frontend can show this
  };
};

// ================= CRUD =================

// GET /users
export const getAllUsers = async (req, res) => {
  try {
    const role = Number(req.user.role_id);
    const { company_id, ship_id, user_id } = req.user;

    let rows;

    if (role === 1) {
      ({ rows } = await db.query("SELECT * FROM users ORDER BY user_id"));
    } else if (role === 2) {
      ({ rows } = await db.query("SELECT * FROM users WHERE company_id = $1 ORDER BY user_id", [
        company_id,
      ]));
    } else if (role === 3) {
      ({ rows } = await db.query(
        "SELECT * FROM users WHERE company_id = $1 AND ship_id = $2 ORDER BY user_id",
        [company_id, ship_id]
      ));
    } else {
      ({ rows } = await db.query("SELECT * FROM users WHERE user_id = $1", [user_id]));
    }

    const out = rows.map((u) => attachPlainPasswordIfAllowed(role, u));
    return res.json(out);
  } catch (err) {
    console.error("Error getting users:", err);
    return res.status(500).json({ error: "Failed to fetch users" });
  }
};

// GET /users/:id
export const getUserById = async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) return res.status(400).json({ error: "user_id must be a number" });

  try {
    const { rows } = await db.query("SELECT * FROM users WHERE user_id = $1", [id]);
    if (!rows.length) return res.status(404).json({ error: "User not found" });

    const role = Number(req.user.role_id);
    return res.json(attachPlainPasswordIfAllowed(role, rows[0]));
  } catch (err) {
    console.error("Error getting user:", err);
    return res.status(500).json({ error: "Failed to fetch user" });
  }
};

// POST /users
export const createUser = async (req, res) => {
  const role = Number(req.user.role_id);

  const {
    seafarer_id,
    full_name,
    rank,
    trip,
    embarkation_date,
    disembarkation_date,
    status,
    ship_id,
    company_id,

    // NEW fields
    sex,
    date_of_birth,
    place_of_birth,
    nationality,
    embarkation_port,
    disembarkation_port,
    end_of_contract,
    plus_months,
    passport_number,
    passport_issue_place,
    passport_issue_date,
    passport_expiry_date,
    seaman_book_number,
    seaman_book_issue_date,
    seaman_book_expiry_date,

    role_id, // optionally allow create user role (careful)
  } = req.body;

  if (!seafarer_id || !full_name) {
    return res.status(400).json({ error: "seafarer_id and full_name are required" });
  }

  const onboardNow = isOnboard(status);

  try {
    let generatedUsername = null;
    let generatedPassword = null;
    let passwordHashToStore = null;
    let passwordEncToStore = null;

    if (onboardNow) {
      generatedUsername = await createUniqueUsername(seafarer_id);
      generatedPassword = generatePassword(12);
      passwordHashToStore = hashPassword(generatedPassword);
      passwordEncToStore = encryptPassword(generatedPassword);
    }

    const { rows } = await db.query(
      `INSERT INTO users
       (seafarer_id, full_name, rank, trip,
        embarkation_date, disembarkation_date, status,
        username, password_hash, password_enc,
        ship_id, company_id,
        sex, date_of_birth, place_of_birth, nationality,
        embarkation_port, disembarkation_port, end_of_contract, plus_months,
        passport_number, passport_issue_place, passport_issue_date, passport_expiry_date,
        seaman_book_number, seaman_book_issue_date, seaman_book_expiry_date,
        role_id,
        created_at, updated_at)
       VALUES
       ($1,$2,$3,$4,
        $5,$6,$7,
        $8,$9,$10,
        $11,$12,
        $13,$14,$15,$16,
        $17,$18,$19,$20,
        $21,$22,$23,$24,
        $25,$26,$27,
        $28,
        NOW(), NOW())
       RETURNING *`,
      [
        seafarer_id,
        full_name,
        rank ?? null,
        trip ?? null,
        embarkation_date ?? null,
        disembarkation_date ?? null,
        status ?? null,

        generatedUsername,
        passwordHashToStore,
        passwordEncToStore,

        ship_id ?? null,
        company_id ?? null,

        sex ?? null,
        date_of_birth ?? null,
        place_of_birth ?? null,
        nationality ?? null,

        embarkation_port ?? null,
        disembarkation_port ?? null,
        end_of_contract ?? null,
        plus_months ?? null,

        passport_number ?? null,
        passport_issue_place ?? null,
        passport_issue_date ?? null,
        passport_expiry_date ?? null,

        seaman_book_number ?? null,
        seaman_book_issue_date ?? null,
        seaman_book_expiry_date ?? null,

        role_id ?? 4,
      ]
    );

    const user = attachPlainPasswordIfAllowed(role, rows[0]);

    return res.status(201).json({
      user,
      credentials: onboardNow
        ? { username: generatedUsername, password: generatedPassword }
        : null,
    });
  } catch (err) {
    console.error("Error creating user:", err);
    if (err.code === "23505") {
      return res.status(409).json({ error: "Duplicate seafarer_id or username" });
    }
    return res.status(500).json({ error: "Failed to create user" });
  }
};

// PUT /users/:id
// Generates creds ONLY if status becomes Onboard and user doesn't have creds yet.
export const updateUser = async (req, res) => {
  const role = Number(req.user.role_id);
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) return res.status(400).json({ error: "user_id must be a number" });

  const body = req.body;

  try {
    const currentRes = await db.query(
      `SELECT user_id, seafarer_id, status, username, password_hash, ship_id, company_id
       FROM users
       WHERE user_id = $1`,
      [id]
    );
    if (!currentRes.rows.length) return res.status(404).json({ error: "User not found" });

    const current = currentRes.rows[0];

    const nextStatus = body.status !== undefined ? body.status : current.status;
    const nextOnboard = isOnboard(nextStatus);
    const hasCreds = !!(current.username && current.password_hash);

    let newUsername = null;
    let newPassword = null;
    let newPasswordHash = null;
    let newPasswordEnc = null;

    if (nextOnboard && !hasCreds) {
      const sidForUsername = body.seafarer_id || current.seafarer_id;
      newUsername = await createUniqueUsername(sidForUsername);
      newPassword = generatePassword(12);
      newPasswordHash = hashPassword(newPassword);
      newPasswordEnc = encryptPassword(newPassword);
    }

    // store old ship before update for history
    const old_ship_id = current.ship_id ?? null;
    const company_id = current.company_id ?? null;
    const new_ship_id = body.ship_id ?? old_ship_id;

    const { rowCount } = await db.query(
      `UPDATE users
       SET
         seafarer_id = COALESCE($1, seafarer_id),
         full_name = COALESCE($2, full_name),
         rank = COALESCE($3, rank),
         trip = COALESCE($4, trip),
         embarkation_date = COALESCE($5, embarkation_date),
         disembarkation_date = COALESCE($6, disembarkation_date),
         status = COALESCE($7, status),

         username = COALESCE($8::varchar, username),
         password_hash = COALESCE($9::varchar, password_hash),
         password_enc = COALESCE($10::text, password_enc),

         ship_id = COALESCE($11, ship_id),
         company_id = COALESCE($12::uuid, company_id),

         sex = COALESCE($13, sex),
         date_of_birth = COALESCE($14, date_of_birth),
         place_of_birth = COALESCE($15, place_of_birth),
         nationality = COALESCE($16, nationality),

         embarkation_port = COALESCE($17, embarkation_port),
         disembarkation_port = COALESCE($18, disembarkation_port),
         end_of_contract = COALESCE($19, end_of_contract),
         plus_months = COALESCE($20, plus_months),

         passport_number = COALESCE($21, passport_number),
         passport_issue_place = COALESCE($22, passport_issue_place),
         passport_issue_date = COALESCE($23, passport_issue_date),
         passport_expiry_date = COALESCE($24, passport_expiry_date),

         seaman_book_number = COALESCE($25, seaman_book_number),
         seaman_book_issue_date = COALESCE($26, seaman_book_issue_date),
         seaman_book_expiry_date = COALESCE($27, seaman_book_expiry_date),

         updated_at = NOW()
       WHERE user_id = $28`,
      [
        body.seafarer_id ?? null,
        body.full_name ?? null,
        body.rank ?? null,
        body.trip ?? null,
        body.embarkation_date ?? null,
        body.disembarkation_date ?? null,
        body.status ?? null,

        newUsername,
        newPasswordHash,
        newPasswordEnc,

        body.ship_id ?? null,
        body.company_id ?? null,

        body.sex ?? null,
        body.date_of_birth ?? null,
        body.place_of_birth ?? null,
        body.nationality ?? null,

        body.embarkation_port ?? null,
        body.disembarkation_port ?? null,
        body.end_of_contract ?? null,
        body.plus_months ?? null,

        body.passport_number ?? null,
        body.passport_issue_place ?? null,
        body.passport_issue_date ?? null,
        body.passport_expiry_date ?? null,

        body.seaman_book_number ?? null,
        body.seaman_book_issue_date ?? null,
        body.seaman_book_expiry_date ?? null,

        id,
      ]
    );

    if (!rowCount) return res.status(404).json({ error: "User not found" });

    // ✅ ship history auto update ONLY if ship changed
    await handleShipHistoryChange({
      user_id: id,
      company_id,
      old_ship_id,
      new_ship_id,
      embarkation_date: body.embarkation_date,
      disembarkation_date: body.disembarkation_date,
      embarkation_port: body.embarkation_port,
      disembarkation_port: body.disembarkation_port,
      changed_by_user_id: req.user.user_id,
      notes: "Manual user update",
    });

    return res.json({
      message: "User updated",
      credentials: newUsername && newPassword ? { username: newUsername, password: newPassword } : null,
    });
  } catch (err) {
    console.error("Error updating user:", err);
    if (err.code === "23505") {
      return res.status(409).json({ error: "Duplicate seafarer_id or username" });
    }
    return res.status(500).json({ error: "Failed to update user" });
  }
};


// DELETE /users/:id
export const deleteUser = async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) return res.status(400).json({ error: "user_id must be a number" });

  try {
    const { rowCount } = await db.query("DELETE FROM users WHERE user_id = $1", [id]);
    if (!rowCount) return res.status(404).json({ error: "User not found" });
    return res.json({ message: "User deleted" });
  } catch (err) {
    console.error("Error deleting user:", err);
    return res.status(500).json({ error: "Failed to delete user" });
  }
};

// PATCH /users/bulk-status
export const bulkUpdateUserStatus = async (req, res) => {
  const role = Number(req.user?.role_id);

  const user_ids = Array.isArray(req.body?.user_ids) ? req.body.user_ids : [];
  const statusRaw = req.body?.status;
  const remove_credentials = Boolean(req.body?.remove_credentials);

  const status = statusRaw != null ? String(statusRaw).trim() : "";
  const isTargetOnboard = isOnboard(status);
  const isTargetOffboard = normalizeStatus(status) === "offboard";

  if (!user_ids.length) {
    return res.status(400).json({ error: "user_ids must be a non-empty array" });
  }
  if (!status || (!isTargetOnboard && !isTargetOffboard)) {
    return res.status(400).json({ error: 'status must be either "Onboard" or "Offboard"' });
  }

  // sanitize ids
  const ids = user_ids
    .map((x) => Number.parseInt(String(x), 10))
    .filter((n) => Number.isInteger(n) && n > 0);

  if (!ids.length) {
    return res.status(400).json({ error: "user_ids must contain valid integer IDs" });
  }

  try {
    await db.query("BEGIN");

    // 1) Fetch users + enforce scope (company/ship) for role 2/3
    const { rows: users } = await db.query(
      `SELECT user_id, seafarer_id, company_id, ship_id, status, username, password_hash
       FROM users
       WHERE user_id = ANY($1::int[])
       FOR UPDATE`,
      [ids]
    );

    if (!users.length) {
      await db.query("ROLLBACK");
      return res.status(404).json({ error: "No users found for given user_ids" });
    }

    // scope check
    const myCompany = req.user?.company_id ? String(req.user.company_id) : null;
    const myShip = req.user?.ship_id != null ? Number(req.user.ship_id) : null;

    const violations = [];
    for (const u of users) {
      if (role === 2 && myCompany && String(u.company_id) !== myCompany) violations.push(u.user_id);
      if (role === 3) {
        if (myCompany && String(u.company_id) !== myCompany) violations.push(u.user_id);
        if (myShip != null && Number(u.ship_id) !== myShip) violations.push(u.user_id);
      }
    }
    if (violations.length) {
      await db.query("ROLLBACK");
      return res.status(403).json({
        error: "Scope violation: some user_ids are outside your company/ship scope",
        violations,
      });
    }

    // 2) Update each user (need per-user credential generation)
    const results = {
      requested: ids.length,
      found: users.length,
      updated: 0,
      generated_credentials: [], // only those newly generated
      skipped: 0,
      skipped_reasons: [],
    };

    for (const u of users) {
      const hasCreds = !!(u.username && u.password_hash);

      // generate creds only when moving to onboard AND creds missing
      let username = null;
      let plainPassword = null;
      let password_hash = null;
      let password_enc = null;

      if (isTargetOnboard && !hasCreds) {
        username = await createUniqueUsername(u.seafarer_id);
        plainPassword = generatePassword(12);
        password_hash = hashPassword(plainPassword);
        password_enc = encryptPassword(plainPassword);
      }

      // if offboarding and user wants credentials removed
      const clearCreds = isTargetOffboard && remove_credentials;

      const { rowCount } = await db.query(
        `UPDATE users
         SET
           status = $1,
           username = CASE WHEN $2::boolean THEN NULL ELSE COALESCE($3::varchar, username) END,
           password_hash = CASE WHEN $2::boolean THEN NULL ELSE COALESCE($4::varchar, password_hash) END,
           password_enc = CASE WHEN $2::boolean THEN NULL ELSE COALESCE($5::text, password_enc) END,
           updated_at = NOW()
         WHERE user_id = $6`,
        [
          status,
          clearCreds,
          username,
          password_hash,
          password_enc,
          u.user_id,
        ]
      );

      if (!rowCount) {
        results.skipped++;
        results.skipped_reasons.push({ user_id: u.user_id, reason: "Not updated" });
        continue;
      }

      results.updated++;

      if (plainPassword) {
        results.generated_credentials.push({
          user_id: u.user_id,
          seafarer_id: u.seafarer_id,
          username,
          password: plainPassword,
        });
      }
    }

    await db.query("COMMIT");
    return res.json({
      message: "Bulk status update completed",
      status,
      remove_credentials,
      ...results,
    });
  } catch (err) {
    await db.query("ROLLBACK");
    console.error("bulkUpdateUserStatus error:", err);
    return res.status(500).json({ error: "Failed to bulk update user status" });
  }
};



// ================== EXCEL IMPORT (multi-template + multi-sheet) ==================
const upload = multer({ storage: multer.memoryStorage() });

// ---- Aliases: add/remove as you discover new template names ----
const FIELD_ALIASES = {
  // Used by many templates
  seafarer_id: [
    "seafarer id",
    "seafarer_id",
    "id",
    "cid",
    "crew id",
    "crew_id",
    "crew pin",
    "crew_pin",
    "srn",
    "seafarer no",
    "seafarer number",
    "seafarer id", "seafarer_id", "id", "cid",
    "crew id", "crew_id", "crew pin", "crew_pin",
    "srn", "seafarer no", "seafarer number",
    "crew ipn", "crew_ipn", "ipn", "crewipn",
    "employee code",
    "emp code",
    "employee id",
    "emp id",
    "staff id",

    // ✅ format2.xlsx
    "crew ipn",
    "crew_ipn",
    "ipn",
    "crewipn",
    "crew ipn#",
    "crew ipn #",
    "crew ipn no",
    "crew ipn number",

    // ✅ IMO Crew List template (important!)
    "number of identity document",
    "identity document number",
    "document number",
    "id document number",
    "seaman book no",
    "seaman book number",
    "passport no",
    "passport number",
  ],

  // Some templates have a direct name column, some are split into family/given
  full_name: [
    "full name",
    "full_name",
    "name",
    "seafarer",
    "crew name",
    "crew_name",

    // ✅ format2.xlsx weird usage (you said LAST_NAME contains full text sometimes)
    "last_name",
    "last name",
    // ✅ TRAINING TEMPLATE
    "employee name",
    "emp name",
    "staff name",
  ],

  // ✅ IMO template split name
  family_name: ["family name", "surname", "last name"],
  given_names: ["given names", "given  names", "first name", "forename"],

  rank: ["rank", "position", "designation", "rank_code", "rank code", "rank or rating", "rank", "position", "designation",
    "job title", "designation name"],
  trip: ["trip", "voyage", "trip no", "trip number"],

  embarkation_port: ["embarkation port", "joining port", "join port", "emb port"],
  embarkation_date: ["embarkation date", "joining date", "join date", "emb date", "sign on", "sign-on"],

  disembarkation_port: ["disembarkation port", "sign off port", "leaving port", "disemb port"],
  disembarkation_date: ["disembarkation date", "sign off", "sign-off", "sign off date", "leaving date", "date of joining", "joining date", "disemb date"],

  end_of_contract: ["end of contract", "eoc", "enc", "end contract", "contract end"],
  plus_months: ["plus months", "extension months", "months", "plus month"],

  sex: ["sex", "gender"],
  date_of_birth: ["date of birth", "dob", "birth date"],
  place_of_birth: ["place of birth", "pob", "birth place"],
  nationality: ["nationality", "country"],

  passport_number: ["passport number", "passport no", "passport_no"],
  passport_issue_place: ["issue place", "passport issue place", "place of issue", "poi", "country of issue"],
  passport_issue_date: ["issue date", "passport issue date", "passport issued", "issued date"],
  passport_expiry_date: ["expiry date", "passport expiry date", "passport expires", "exp date"],

  seaman_book_number: ["seaman's book number", "seaman book number", "seaman book no", "sb number", "number of identity document"],
  seaman_book_issue_date: ["issue date.1", "seaman book issue date", "sb issue date"],
  seaman_book_expiry_date: ["expiry date.1", "seaman book expiry date", "sb expiry date"],

  status: ["status", "crew status", "onboard/offboard"],
};

const getByAliases = (row, aliases) => {
  const keys = Object.keys(row || {});
  for (const alias of aliases) {
    const wanted = normalizeKey(alias);
    const found = keys.find((k) => normalizeKey(k) === wanted);
    if (found) return row[found];
  }
  return null;
};

// ✅ Build objects from a matrix (handles "blank header" columns safely)
const matrixToObjects = (matrix, headerRowIdx) => {
  const headersRaw = (matrix[headerRowIdx] || []).map((h) => (h == null ? "" : String(h).trim()));
  const headers = headersRaw.map((h, i) => (h ? h : `__col_${i + 1}`)); // unique placeholder keys

  const out = [];
  for (let r = headerRowIdx + 1; r < matrix.length; r++) {
    const rowArr = matrix[r] || [];
    // ignore fully empty rows
    const hasAny = rowArr.some((v) => v !== null && v !== undefined && String(v).trim() !== "");
    if (!hasAny) continue;

    const obj = {};
    for (let c = 0; c < headers.length; c++) obj[headers[c]] = rowArr[c] ?? null;
    out.push(obj);
  }
  return { headers, rows: out };
};

// Detect header row by scanning first N rows and checking if template matches
const detectHeaderRowIndex = (matrix) => {
  const maxScan = Math.min(matrix.length, 80);

  const idSet = new Set(FIELD_ALIASES.seafarer_id.map(normalizeKey));
  const nameSet = new Set(FIELD_ALIASES.full_name.map(normalizeKey));

  const familySet = new Set(FIELD_ALIASES.family_name.map(normalizeKey));
  const givenSet = new Set(FIELD_ALIASES.given_names.map(normalizeKey));

  for (let r = 0; r < maxScan; r++) {
    const row = matrix[r] || [];
    const normalized = row.map(normalizeKey);

    const hasId = normalized.some((x) => idSet.has(x));
    const hasName = normalized.some((x) => nameSet.has(x));

    // ✅ Template A/B: has direct ID + direct Name
    if (hasId && hasName) return r;

    // ✅ IMO Template: family+given OR family only plus identity doc number
    const hasFamily = normalized.some((x) => familySet.has(x));
    const hasGiven = normalized.some((x) => givenSet.has(x));
    const hasIdentity = normalized.some((x) => idSet.has(x)); // includes "number of identity document"

    if (hasFamily && (hasGiven || hasIdentity)) return r;
  }
  return -1;
};

// ✅ Full name getter supports split columns (Family/Given)
const getFullNameSmart = (row) => {
  const direct = getByAliases(row, FIELD_ALIASES.full_name);
  if (direct != null && String(direct).trim() !== "") return String(direct).trim();

  const family = getByAliases(row, FIELD_ALIASES.family_name);
  const given = getByAliases(row, FIELD_ALIASES.given_names);

  const f = family != null ? String(family).trim() : "";
  const g = given != null ? String(given).trim() : "";

  const combined = `${f} ${g}`.trim();
  return combined || null;
};

// Validate company_id + ship_id from form data and enforce role scope (same as yours)
const resolveImportScope = async (req) => {
  const role = Number(req.user?.role_id);

  const company_id = String(req.body?.company_id || "").trim();
  const ship_id_raw = req.body?.ship_id;
  const ship_id = ship_id_raw !== undefined ? parseIntOrNull(ship_id_raw) : null;

  if (!isUuid(company_id)) return { error: "company_id is required and must be a valid UUID" };
  if (ship_id === null || Number.isNaN(ship_id)) return { error: "ship_id is required and must be a number" };

  const c = await db.query("SELECT company_id FROM company WHERE company_id = $1", [company_id]);
  if (!c.rows.length) return { error: "company_id does not exist" };

  const s = await db.query("SELECT ship_id, company_id FROM ships WHERE ship_id = $1", [ship_id]);
  if (!s.rows.length) return { error: "ship_id does not exist" };
  if (String(s.rows[0].company_id) !== company_id) return { error: "ship_id does not belong to company_id" };

  if (role === 2 && String(req.user.company_id) !== company_id) {
    return { error: "Role 2 company scope violation" };
  }
  if (role === 3) {
    if (String(req.user.company_id) !== company_id) return { error: "Role 3 company scope violation" };
    if (Number(req.user.ship_id) !== ship_id) return { error: "Role 3 ship scope violation" };
  }

  return { company_id, ship_id };
};

// ✅ NEW: pick the first sheet that contains a recognizable header
const pickSheetWithHeader = (wb, requestedSheetName) => {
  const trySheet = (name) => {
    const sheet = wb.Sheets[name];
    if (!sheet) return null;

    const matrix = xlsx.utils.sheet_to_json(sheet, { header: 1, defval: null, raw: true });
    const headerRowIdx = detectHeaderRowIndex(matrix);
    if (headerRowIdx === -1) return null;

    return { sheetName: name, sheet, matrix, headerRowIdx };
  };

  if (requestedSheetName) {
    const name = String(requestedSheetName).trim();
    const found = trySheet(name);
    if (!found) return { error: `sheet_name "${name}" not found OR header not detected in that sheet` };
    return found;
  }

  for (const name of wb.SheetNames) {
    const found = trySheet(name);
    if (found) return found;
  }

  return {
    error:
      "Could not detect header row in any sheet. Supported templates need either (ID + Name) OR (Family name + Given names / identity document).",
  };
};

// POST /users/import (roles 1/2/3)
// POST /users/import (roles 1/2/3)
export const importUsersFromExcel = [
  upload.single("file"),
  async (req, res) => {
    const role = Number(req.user?.role_id);
    if (![1, 2, 3].includes(role)) return res.status(403).json({ error: "Forbidden" });

    if (!req.file) {
      return res.status(400).json({ error: 'Excel file is required (field name: "file")' });
    }

    try {
      // 1) Validate and lock import scope
      const scope = await resolveImportScope(req);
      if (scope.error) return res.status(400).json({ error: scope.error });
      const { company_id, ship_id } = scope;

      // 2) Parse workbook + find sheet/header
      const wb = xlsx.read(req.file.buffer, { type: "buffer", cellDates: true });
      const picked = pickSheetWithHeader(wb, req.body?.sheet_name);
      if (picked.error) return res.status(400).json({ error: picked.error });

      const { sheetName, matrix, headerRowIdx } = picked;

      // 3) Convert rows using our safe matrix conversion
      const { rows } = matrixToObjects(matrix, headerRowIdx);
      if (!rows.length) return res.status(400).json({ error: "Excel sheet is empty" });

      const results = {
        import_scope: { company_id, ship_id },
        detected_sheet: sheetName,
        detected_header_row: headerRowIdx + 1,
        total_rows: rows.length,
        inserted: 0,
        skipped: 0,
        errors: [],
        created_credentials: [],
      };

      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        const rowNum = headerRowIdx + 2 + i;

        // Required (smart)
        const full_name = getFullNameSmart(r);
        const sidCandidate = getByAliases(r, FIELD_ALIASES.seafarer_id);

        const seafarer_id =
          sidCandidate != null && String(sidCandidate).trim() !== ""
            ? String(sidCandidate).replace(/\s+/g, " ").trim()
            : null;

        if (!seafarer_id || !full_name) {
          results.skipped++;
          results.errors.push({
            row: rowNum,
            error:
              "Missing required identity (ID/Crew IPN/Number of identity document/etc) OR name (Name/Seafarer/Family+Given).",
          });
          continue;
        }

        // Optional fields
        const rank = getByAliases(r, FIELD_ALIASES.rank);
        const sex = getByAliases(r, FIELD_ALIASES.sex);
        const nationality = getByAliases(r, FIELD_ALIASES.nationality);
        const place_of_birth = getByAliases(r, FIELD_ALIASES.place_of_birth);

        const date_of_birth = parseDateOrNull(getByAliases(r, FIELD_ALIASES.date_of_birth));

        const embarkation_port = getByAliases(r, FIELD_ALIASES.embarkation_port);
        const embarkation_date = parseDateOrNull(getByAliases(r, FIELD_ALIASES.embarkation_date));

        const disembarkation_port = getByAliases(r, FIELD_ALIASES.disembarkation_port);
        const disembarkation_date = parseDateOrNull(getByAliases(r, FIELD_ALIASES.disembarkation_date));

        const end_of_contract = parseDateOrNull(getByAliases(r, FIELD_ALIASES.end_of_contract));
        const plus_months = parseIntOrNull(getByAliases(r, FIELD_ALIASES.plus_months));

        const passport_number = getByAliases(r, FIELD_ALIASES.passport_number);
        const passport_issue_place = getByAliases(r, FIELD_ALIASES.passport_issue_place);
        const passport_issue_date = parseDateOrNull(getByAliases(r, FIELD_ALIASES.passport_issue_date));
        const passport_expiry_date = parseDateOrNull(getByAliases(r, FIELD_ALIASES.passport_expiry_date));

        const seaman_book_number = getByAliases(r, FIELD_ALIASES.seaman_book_number);
        const seaman_book_issue_date = parseDateOrNull(getByAliases(r, FIELD_ALIASES.seaman_book_issue_date));
        const seaman_book_expiry_date = parseDateOrNull(getByAliases(r, FIELD_ALIASES.seaman_book_expiry_date));

        // Status from excel or computed
        const statusFromExcel = getByAliases(r, FIELD_ALIASES.status);
        let status =
          statusFromExcel != null && String(statusFromExcel).trim() !== ""
            ? String(statusFromExcel)
            : computeStatusFromDates({ disembarkation_date });

        // ✅ Auto role assignment:
        // If rank is senior → role_id=3 + force Onboard
        const role_id_to_insert = isShipAdminRank(rank) ? 3 : 4;

        if (role_id_to_insert === 3) {
          status = "Onboard";
        }

        // ✅ If this user already exists in same company, UPDATE instead of INSERT
        const existingRes = await db.query(
          `SELECT user_id, ship_id, company_id
           FROM users
           WHERE seafarer_id = $1 AND company_id = $2
           LIMIT 1`,
          [seafarer_id, company_id]
        );
        const existingUser = existingRes.rows[0] || null;

        if (existingUser) {
          // IMPORTANT: do NOT regenerate password on transfer
          await db.query(
            `UPDATE users
             SET
               full_name = COALESCE($1, full_name),
               rank = COALESCE($2, rank),
               ship_id = $3,
               status = $4,
               embarkation_date = COALESCE($5, embarkation_date),
               disembarkation_date = COALESCE($6, disembarkation_date),
               embarkation_port = COALESCE($7, embarkation_port),
               disembarkation_port = COALESCE($8, disembarkation_port),
               role_id = COALESCE($9, role_id),
               updated_at = NOW()
             WHERE user_id = $10`,
            [
              full_name,
              rank ?? null,
              ship_id,
              status,
              embarkation_date ?? null,
              disembarkation_date ?? null,
              embarkation_port ?? null,
              disembarkation_port ?? null,
              role_id_to_insert,
              existingUser.user_id,
            ]
          );

          const oldShip = existingUser.ship_id ?? null;
          const newShip = ship_id;

          if (Number(oldShip) !== Number(newShip)) {
            await handleShipHistoryChange({
              user_id: existingUser.user_id,
              company_id,
              old_ship_id: oldShip,
              new_ship_id: newShip,
              embarkation_date,
              disembarkation_date,
              embarkation_port,
              disembarkation_port,
              changed_by_user_id: req.user.user_id,
              notes: "Excel import (existing user ship update)",
            });
          }

          results.inserted++; // (counts as processed)
          continue;
        }

        // Validate numbers/dates if present
        if (plus_months !== null && Number.isNaN(plus_months)) {
          results.skipped++;
          results.errors.push({ row: rowNum, error: "Plus Months must be a number (if provided)" });
          continue;
        }

        const dateFields = [
          ["date_of_birth", date_of_birth],
          ["embarkation_date", embarkation_date],
          ["disembarkation_date", disembarkation_date],
          ["end_of_contract", end_of_contract],
          ["passport_issue_date", passport_issue_date],
          ["passport_expiry_date", passport_expiry_date],
          ["seaman_book_issue_date", seaman_book_issue_date],
          ["seaman_book_expiry_date", seaman_book_expiry_date],
        ];
        const badDate = dateFields.find(([, v]) => v !== null && Number.isNaN(v));
        if (badDate) {
          results.skipped++;
          results.errors.push({ row: rowNum, error: `Invalid date in ${badDate[0]}` });
          continue;
        }

        // ✅ Generate credentials if onboard
        let username = null;
        let password = null;
        let password_hash = null;
        let password_enc = null;

        if (isOnboard(status)) {
          username = await createUniqueUsername(seafarer_id);
          password = generatePassword(12);
          password_hash = hashPassword(password);
          password_enc = encryptPassword(password);
        }

        try {
          const { rows: inserted } = await db.query(
            `INSERT INTO users
              (seafarer_id, full_name, rank, trip,
               embarkation_date, disembarkation_date, status,
               username, password_hash, password_enc,
               ship_id, company_id,
               sex, date_of_birth, place_of_birth, nationality,
               embarkation_port, disembarkation_port, end_of_contract, plus_months,
               passport_number, passport_issue_place, passport_issue_date, passport_expiry_date,
               seaman_book_number, seaman_book_issue_date, seaman_book_expiry_date,
               role_id,
               created_at, updated_at)
             VALUES
              ($1,$2,$3,$4,
               $5,$6,$7,
               $8,$9,$10,
               $11,$12,
               $13,$14,$15,$16,
               $17,$18,$19,$20,
               $21,$22,$23,$24,
               $25,$26,$27,
               $28,
               NOW(), NOW())
             RETURNING user_id, seafarer_id, full_name, username, status, role_id`,
            [
              seafarer_id,
              full_name,
              rank ?? null,
              null,

              embarkation_date ?? null,
              disembarkation_date ?? null,
              status,

              username,
              password_hash,
              password_enc,

              ship_id,
              company_id,

              sex ?? null,
              date_of_birth ?? null,
              place_of_birth ?? null,
              nationality ?? null,

              embarkation_port ?? null,
              disembarkation_port ?? null,
              end_of_contract ?? null,
              plus_months ?? null,

              passport_number ?? null,
              passport_issue_place ?? null,
              passport_issue_date ?? null,
              passport_expiry_date ?? null,

              seaman_book_number ?? null,
              seaman_book_issue_date ?? null,
              seaman_book_expiry_date ?? null,

              role_id_to_insert, // ✅ FIXED: was hardcoded 4
            ]
          );

          const insertedUserId = inserted[0]?.user_id;

          await handleShipHistoryChange({
            user_id: insertedUserId,
            company_id,
            old_ship_id: null,
            new_ship_id: ship_id,
            embarkation_date,
            disembarkation_date,
            embarkation_port,
            disembarkation_port,
            changed_by_user_id: req.user.user_id,
            notes: "Excel import (new user)",
          });


          results.inserted++;

          if (password) {
            results.created_credentials.push({
              row: rowNum,
              user_id: inserted[0].user_id,
              seafarer_id: inserted[0].seafarer_id,
              username: inserted[0].username,
              password,
              role_id: inserted[0].role_id,
            });
          }
        } catch (e) {
          results.skipped++;
          results.errors.push({
            row: rowNum,
            error: e.code === "23505" ? "Duplicate seafarer_id or username" : e.message,
          });
        }
      }

      return res.status(201).json({
        message: "Excel import completed",
        ...results,
      });
    } catch (err) {
      console.error("importUsersFromExcel error:", err);
      return res.status(500).json({ error: "Failed to import users" });
    }
  },
];