// src/controller/usersController.js
import { db } from "../db.js";
import crypto from "crypto";
import multer from "multer";
import xlsx from "xlsx";

// ================= STATUS / PASSWORD HELPERS =================
const normalizeStatus = (s) => (s ? String(s).trim().toLowerCase() : null);
const isOnboard = (s) => normalizeStatus(s) === "onboard";

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
const normalizeKey = (k) => String(k || "").trim().toLowerCase();

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
      `SELECT user_id, seafarer_id, status, username, password_hash
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

// ================= EXCEL IMPORT =================
const upload = multer({ storage: multer.memoryStorage() });

// Your template required headers (normalized)
const REQUIRED_EXCEL_HEADERS = [
  "seafarer", // name
  "id", // seafarer_id
  "rank",
  "sex",
  "date of birth",
  "place of birth",
  "nationality",
  "embarkation port",
  "embarkation date",
  "disembarkation port",
  "disembarkation date",
  "end of contract",
  "plus months",
  "passport number",
  "issue place",
  "issue date",       // passport issue date
  "expiry date",      // passport expiry date
  "seaman's book number",
  "issue date.1",     // seaman book issue date
  "expiry date.1",    // seaman book expiry date
];

const validateExcelHeaders = (rows) => {
  const headers = Object.keys(rows[0] || {}).map(normalizeKey);
  return REQUIRED_EXCEL_HEADERS.filter((h) => !headers.includes(h));
};

const getCell = (row, key) => {
  const foundKey = Object.keys(row).find((x) => normalizeKey(x) === normalizeKey(key));
  return foundKey ? row[foundKey] : null;
};

// STRICT company/ship validation:
// - role 1: must send company_id and ship_id as form-data fields
// - role 2: company_id forced from token; ship_id optional but validated; if missing, import will allow NULL ship_id
// - role 3: company_id + ship_id forced from token (cannot import other ship/company)
const resolveImportScope = async (req) => {
  const role = Number(req.user.role_id);

  let company_id = null;
  let ship_id = null;

  if (role === 1) {
    company_id = String(req.body.company_id || "").trim();
    ship_id = parseIntOrNull(req.body.ship_id);

    if (!isUuid(company_id)) {
      return { error: "Role 1 must provide valid company_id (uuid) in form-data" };
    }
    if (ship_id === null || Number.isNaN(ship_id)) {
      return { error: "Role 1 must provide valid ship_id (integer) in form-data" };
    }
  }

  if (role === 2) {
    company_id = String(req.user.company_id);
    // ship_id optional from form-data
    const maybeShip = parseIntOrNull(req.body.ship_id);
    ship_id = maybeShip === NaN ? NaN : maybeShip; // might be null
    if (ship_id !== null && Number.isNaN(ship_id)) {
      return { error: "If provided, ship_id must be an integer" };
    }
  }

  if (role === 3) {
    company_id = String(req.user.company_id);
    ship_id = Number(req.user.ship_id);
  }

  // Validate company exists
  const c = await db.query("SELECT company_id FROM company WHERE company_id = $1", [company_id]);
  if (!c.rows.length) return { error: "company_id does not exist" };

  // Validate ship exists + belongs to company (if ship_id not null)
  if (ship_id !== null) {
    const s = await db.query("SELECT ship_id, company_id FROM ships WHERE ship_id = $1", [ship_id]);
    if (!s.rows.length) return { error: "ship_id does not exist" };
    if (String(s.rows[0].company_id) !== String(company_id)) {
      return { error: "ship_id does not belong to company_id" };
    }
  }

  return { company_id, ship_id };
};

// POST /users/import  (roles 1/2/3)
export const importUsersFromExcel = [
  upload.single("file"),
  async (req, res) => {
    const role = Number(req.user?.role_id);
    if (![1, 2, 3].includes(role)) {
      return res.status(403).json({ error: "Forbidden" });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'Excel file is required (field name: "file")' });
    }

    try {
      // 1) Scope (company/ship) resolution + strict validation
      const scope = await resolveImportScope(req);
      if (scope.error) return res.status(400).json({ error: scope.error });
      const { company_id, ship_id } = scope;

      // 2) Parse Excel
      const wb = xlsx.read(req.file.buffer, { type: "buffer" });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const rows = xlsx.utils.sheet_to_json(sheet, { defval: null, raw: true }); // keep Date objects if present

      if (!rows.length) return res.status(400).json({ error: "Excel sheet is empty" });

      // 3) Header validation (template must match)
      const missingHeaders = validateExcelHeaders(rows);
      if (missingHeaders.length) {
        return res.status(400).json({
          error: "Excel template mismatch: missing required columns",
          missing_columns: missingHeaders,
        });
      }

      const results = {
        total_rows: rows.length,
        inserted: 0,
        skipped: 0,
        errors: [],
        created_credentials: [], // show generated username/password for onboard users
      };

      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        const rowNum = i + 2; // assumes row1 header-ish; good enough for frontend reporting

        // Map Excel -> DB fields
        const seafarer_id = getCell(r, "ID");
        const full_name = getCell(r, "Seafarer");
        const sex = getCell(r, "Sex");
        const rank = getCell(r, "Rank");

        const date_of_birth = parseDateOrNull(getCell(r, "Date of Birth"));
        const place_of_birth = getCell(r, "Place of Birth");
        const nationality = getCell(r, "Nationality");

        const embarkation_port = getCell(r, "Embarkation Port");
        const embarkation_date = parseDateOrNull(getCell(r, "Embarkation Date"));

        const disembarkation_port = getCell(r, "Disembarkation Port");
        const disembarkation_date = parseDateOrNull(getCell(r, "Disembarkation Date"));

        const end_of_contract = parseDateOrNull(getCell(r, "End of Contract"));
        const plus_months = parseIntOrNull(getCell(r, "Plus Months"));

        const passport_number = getCell(r, "Passport Number");
        const passport_issue_place = getCell(r, "Issue Place");
        const passport_issue_date = parseDateOrNull(getCell(r, "Issue Date"));
        const passport_expiry_date = parseDateOrNull(getCell(r, "Expiry Date"));

        const seaman_book_number = getCell(r, "Seaman's Book Number");
        const seaman_book_issue_date = parseDateOrNull(getCell(r, "Issue Date.1"));
        const seaman_book_expiry_date = parseDateOrNull(getCell(r, "Expiry Date.1"));

        // Minimal required row checks
        if (!seafarer_id || !full_name) {
          results.skipped++;
          results.errors.push({ row: rowNum, error: "Missing ID (seafarer_id) or Seafarer (full_name)" });
          continue;
        }

        // Validate parsed numbers/dates
        if (plus_months !== null && Number.isNaN(plus_months)) {
          results.skipped++;
          results.errors.push({ row: rowNum, error: "Plus Months must be a number" });
          continue;
        }

        const dateFields = [
          ["Date of Birth", date_of_birth],
          ["Embarkation Date", embarkation_date],
          ["Disembarkation Date", disembarkation_date],
          ["End of Contract", end_of_contract],
          ["Passport Issue Date", passport_issue_date],
          ["Passport Expiry Date", passport_expiry_date],
          ["Seaman Book Issue Date", seaman_book_issue_date],
          ["Seaman Book Expiry Date", seaman_book_expiry_date],
        ];
        const badDate = dateFields.find(([, v]) => v === NaN);
        if (badDate) {
          results.skipped++;
          results.errors.push({ row: rowNum, error: `Invalid date in: ${badDate[0]}` });
          continue;
        }

        // Status: from dates (or you can change this logic)
        const status = computeStatusFromDates({ disembarkation_date });

        // Credentials generation if status onboard
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
             RETURNING user_id`,
            [
              String(seafarer_id),
              String(full_name),
              rank ?? null,
              null, // trip not in template

              embarkation_date ?? null,
              disembarkation_date ?? null,
              status,

              username,
              password_hash,
              password_enc,

              ship_id ?? null,
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

              4, // imported crew = role 4
            ]
          );

          results.inserted++;

          if (password) {
            results.created_credentials.push({
              row: rowNum,
              user_id: inserted[0].user_id,
              seafarer_id,
              username,
              password, // plaintext for frontend (as requested)
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
        import_scope: { company_id, ship_id },
        ...results,
      });
    } catch (err) {
      console.error("importUsersFromExcel error:", err);
      return res.status(500).json({ error: "Failed to import users" });
    }
  },
];
