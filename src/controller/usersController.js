// src/controller/usersController.js
import { db } from "../db.js";
import crypto from "crypto";
import multer from "multer";
import xlsx from "xlsx";
import { handleShipHistoryChange } from "../utils/shipHistory.js";
import { encryptPassword, decryptPassword } from "../utils/cryptoPasswords.js";

// ================= STATUS / PASSWORD HELPERS =================
const normalizeStatus = (s) => (s ? String(s).trim().toLowerCase() : null);
const isOnboard = (s) => normalizeStatus(s) === "onboard";

// ✅ Ship-admin rank detection (role_id=3)
const normalizeRank = (r) =>
  String(r || "")
    .trim()
    .toLowerCase()
    .replace(/[\.\-_,]/g, " ")
    .replace(/[\/\\]/g, " ")
    .replace(/\s+/g, " ");
const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

const getPagination = (req, defaults = { page: 1, limit: 50 }) => {
  const pageRaw = parseInt(String(req.query.page ?? defaults.page), 10);
  const limitRaw = parseInt(String(req.query.limit ?? defaults.limit), 10);

  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : defaults.page;

  // ✅ enforce min 50, max 100 always
  const limit = clamp(
    Number.isFinite(limitRaw) ? limitRaw : defaults.limit,
    50,
    100
  );

  const offset = (page - 1) * limit;
  return { page, limit, offset };
};

// ================= RANK SORTING HELPERS =================
// canonical rank order (lower = higher priority)
const RANK_WEIGHT = {
  MASTER: 1,
  CHIEF_OFFICER: 2,
  SECOND_OFFICER: 3,
  THIRD_OFFICER: 4,
  CHIEF_ENGINEER: 5,
  SECOND_ENGINEER: 6,
  THIRD_ENGINEER: 7,
  ELECTRICIAN: 8,
  BOSUN: 9,
  AB: 10,
  OS: 11,
  OILER: 12,
  WIPER: 13,
  COOK: 14,
  OTHER: 999,
};

// aliases per canonical rank (add more anytime)
const RANK_ALIASES = {
  MASTER: [
    "master", "mstr", "mster", "mst", "mtr",
    "captain", "cap", "capt"
  ],

  CHIEF_OFFICER: [
    "chief officer", "chief mate", "c/o", "coff", "c off",
    "1st officer", "first officer", "1/off", "1off", "1o"
  ],

  SECOND_OFFICER: [
    "second officer", "2nd officer", "2/off", "2off", "2o", "2officer"
  ],

  THIRD_OFFICER: [
    "third officer", "3rd officer", "3/off", "3off", "3o", "3officer"
  ],

  CHIEF_ENGINEER: [
    "chief engineer", "c/e", "ce", "c eng", "cheng", "ch eng"
  ],

  SECOND_ENGINEER: [
    "second engineer", "2nd engineer", "2/e", "2e", "2 eng", "2eng"
  ],

  THIRD_ENGINEER: [
    "third engineer", "3rd engineer", "3/e", "3e", "3 eng", "3eng"
  ],

  ELECTRICIAN: [
    "electrician", "elec", "ee", "j/ee", "jele", "elect"
  ],

  BOSUN: [
    "bosun", "bosn", "boatswain"
  ],

  AB: [
    "ab", "able", "able seaman", "able seafarer", "a/b"
  ],

  OS: [
    "os", "ordinary seaman", "orse"
  ],

  OILER: [
    "oiler"
  ],

  WIPER: [
    "wiper"
  ],

  COOK: [
    "cook", "ccok", "cok", "2cok", "2/cok", "2 cook"
  ],
};

// find canonical rank key from raw rank string
const canonicalRankKey = (rankRaw) => {
  const r = normalizeRank(rankRaw);

  if (!r) return "OTHER";

  // exact / contains match
  for (const [key, list] of Object.entries(RANK_ALIASES)) {
    for (const a of list) {
      const aa = normalizeRank(a);
      if (r === aa) return key;
      if (r.includes(aa)) return key;
    }
  }

  // fallback: handle things like "2OFF", "3ENG", etc.
  // normalizeRank already lowercases, so check patterns
  if (/\b2\s*off\b|\b2off\b/.test(r)) return "SECOND_OFFICER";
  if (/\b3\s*off\b|\b3off\b/.test(r)) return "THIRD_OFFICER";
  if (/\b2\s*eng\b|\b2eng\b/.test(r)) return "SECOND_ENGINEER";
  if (/\b3\s*eng\b|\b3eng\b/.test(r)) return "THIRD_ENGINEER";

  return "OTHER";
};

const rankSortValue = (rankRaw) => {
  const key = canonicalRankKey(rankRaw);
  return RANK_WEIGHT[key] ?? RANK_WEIGHT.OTHER;
};


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
// const encryptPassword = (plain) => {
//   const key = getEncKey();
//   const iv = crypto.randomBytes(12);
//   const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);

//   const ciphertext = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
//   const tag = cipher.getAuthTag();

//   return `${iv.toString("base64")}.${tag.toString("base64")}.${ciphertext.toString("base64")}`;
// };

// const decryptPassword = (enc) => {
//   try {
//     if (!enc) return null;
//     const [ivB64, tagB64, ctB64] = String(enc).split(".");
//     if (!ivB64 || !tagB64 || !ctB64) return null;

//     const key = getEncKey();
//     const iv = Buffer.from(ivB64, "base64");
//     const tag = Buffer.from(tagB64, "base64");
//     const ciphertext = Buffer.from(ctB64, "base64");

//     const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
//     decipher.setAuthTag(tag);

//     const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
//     return plain.toString("utf8");
//   } catch {
//     return null;
//   }
// };

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
  if (v === null || v === undefined) return null;

  // 1) Date object (xlsx cellDates: true)
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return null;
    return v.toISOString().slice(0, 10);
  }

  // 2) Excel serial number
  if (typeof v === "number" && Number.isFinite(v)) {
    const ms = Math.round((v - 25569) * 86400 * 1000); // Excel epoch
    const d = new Date(ms);
    if (Number.isNaN(d.getTime())) return null;
    return d.toISOString().slice(0, 10);
  }

  // 3) Clean strings (your file has newlines/spaces)
  let s = String(v).trim();
  if (!s) return null;
  s = s.replace(/\s+/g, ""); // remove spaces/newlines like "07.12.2025 \n"

  // 4) ISO formats: YYYY-MM-DD or YYYY/MM/DD
  let m = s.match(/^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})$/);
  if (m) {
    const yyyy = Number(m[1]);
    const mm = Number(m[2]);
    const dd = Number(m[3]);
    if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
    const d = new Date(Date.UTC(yyyy, mm - 1, dd));
    return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  }

  // 5) DMY formats with ".", "/", "-" and 2-digit OR 4-digit year
  // examples: 29.09.2025, 21.01.26, 07/12/2025, 6-9-2025
  m = s.match(/^(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{2}|\d{4})$/);
  if (m) {
    let dd = Number(m[1]);
    let mm = Number(m[2]);
    let yy = Number(m[3]);

    // your sheets are DMY; also protects from JS MM/DD confusion
    let yyyy = yy < 100 ? 2000 + yy : yy;

    if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
    const d = new Date(Date.UTC(yyyy, mm - 1, dd));
    return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  }

  // 6) LAST fallback: only for month-name formats like "12 Sep 2025"
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
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

const USER_SAFE_COLUMNS = `
  user_id,
  seafarer_id,
  full_name,
  rank,
  trip,
  embarkation_date,
  disembarkation_date,
  status,
  username,
  ship_id,
  company_id,
  created_at,
  updated_at,
  role_id,
  sex,
  password_enc
`;

// ================= CRUD =================

// GET /users
// GET /users
export const getAllUsers = async (req, res) => {
  try {
    const role = Number(req.user.role_id);
    const myCompanyId = req.user?.company_id ? String(req.user.company_id) : null;
    const myShipId = req.user?.ship_id != null ? Number(req.user.ship_id) : null;
    const myUserId = req.user?.user_id;

    // role 4 unchanged: only self
    if (role === 4) {
      const { rows } = await db.query(
        `SELECT ${USER_SAFE_COLUMNS}
         FROM users
         WHERE user_id = $1`,
        [myUserId]
      );
      if (!rows.length) return res.status(404).json({ error: "User not found" });
      return res.json(attachPlainPasswordIfAllowed(role, rows[0]));
    }

    // pagination (min 10 max 100)
    const { page, limit, offset } = getPagination(req, { page: 1, limit: 50 });

    // filters
    const q = String(req.query.q ?? "").trim();
    const rank = String(req.query.rank ?? "").trim();
    const status = String(req.query.status ?? "").trim();

    // for superadmin/admin use:
    const company_id_q = String(req.query.company_id ?? "").trim();
    const ship_id_q_raw = req.query.ship_id;
    const ship_id_q =
      ship_id_q_raw != null && String(ship_id_q_raw).trim() !== ""
        ? Number.parseInt(String(ship_id_q_raw), 10)
        : null;

    // sort whitelist
    const sort = String(req.query.sort ?? "user_id").trim().toLowerCase(); // user_id | name | created_at | rank
    const order = String(req.query.order ?? "asc").trim().toLowerCase() === "desc" ? "DESC" : "ASC";

    const sortColumn =
      sort === "name" ? "u.full_name" :
        sort === "created_at" ? "u.created_at" :
          "u.user_id";

    // dynamic where
    const where = [];
    const params = [];
    let idx = 1;

    // ---- role scope enforcement ----
    if (role === 1) {
      // superadmin optional company filter
      if (company_id_q) {
        if (!isUuid(company_id_q)) {
          return res.status(400).json({ error: "company_id must be a valid UUID" });
        }
        where.push(`u.company_id = $${idx++}`);
        params.push(company_id_q);
      }
      // superadmin optional ship filter
      if (Number.isFinite(ship_id_q)) {
        where.push(`u.ship_id = $${idx++}`);
        params.push(ship_id_q);
      }
    }

    if (role === 2) {
      // admin forced to own company
      if (!myCompanyId) return res.json({ page, limit, total: 0, count: 0, users: [] });

      where.push(`u.company_id = $${idx++}`);
      params.push(myCompanyId);

      // optional ship filter (must be within company implicitly)
      if (Number.isFinite(ship_id_q)) {
        where.push(`u.ship_id = $${idx++}`);
        params.push(ship_id_q);
      }
    }

    if (role === 3) {
      // subadmin forced to own company + ship
      if (!myCompanyId || myShipId == null) return res.json({ page, limit, total: 0, count: 0, users: [] });

      where.push(`u.company_id = $${idx++}`);
      params.push(myCompanyId);

      where.push(`u.ship_id = $${idx++}`);
      params.push(myShipId);
    }

    // Hide Superadmin (1) & Admin (2) from user listings
    where.push(`u.role_id IN (3, 4)`);

    // ---- search filters ----
    if (q) {
      where.push(`(
        u.full_name ILIKE $${idx}
        OR u.seafarer_id ILIKE $${idx}
        OR u.username ILIKE $${idx}
      )`);
      params.push(`%${q}%`);
      idx++;
    }

    if (rank) {
      where.push(`u.rank ILIKE $${idx++}`);
      params.push(`%${rank}%`);
    }

    if (status) {
      where.push(`LOWER(COALESCE(u.status,'')) = LOWER($${idx++})`);
      params.push(status);
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    // total
    const totalRes = await db.query(
      `SELECT COUNT(*)::int AS total
       FROM users u
       ${whereSql}`,
      params
    );
    const total = totalRes.rows[0]?.total ?? 0;

    // data
    const dataParams = [...params, limit, offset];
    const { rows } = await db.query(
      `SELECT ${USER_SAFE_COLUMNS}
       FROM users u
       ${whereSql}
       ORDER BY ${sortColumn} ${order}
       LIMIT $${idx} OFFSET $${idx + 1}`,
      dataParams
    );

    // attach plain_password ONLY for allowed roles
    const out = rows.map((u) => attachPlainPasswordIfAllowed(role, u));

    // if frontend asks sort=rank, keep your JS rank ordering (within page)
    if (sort === "rank") {
      out.sort((a, b) => {
        const ra = rankSortValue(a.rank);
        const rb = rankSortValue(b.rank);
        if (ra !== rb) return ra - rb;

        return String(a.full_name || "").localeCompare(
          String(b.full_name || ""),
          undefined,
          { sensitivity: "base" }
        );
      });
    }

    return res.json({
      page,
      limit,
      total,
      count: out.length,
      users: out,
      applied_filters: {
        q: q || null,
        rank: rank || null,
        status: status || null,
        company_id: role === 1 ? (company_id_q || null) : (role === 2 || role === 3 ? myCompanyId : null),
        ship_id:
          role === 1 ? (Number.isFinite(ship_id_q) ? ship_id_q : null)
            : role === 2 ? (Number.isFinite(ship_id_q) ? ship_id_q : null)
              : role === 3 ? myShipId
                : null,
        sort,
        order: order.toLowerCase(),
      },
    });
  } catch (err) {
    console.error("Error getting users:", err);
    return res.status(500).json({ error: "Failed to fetch users" });
  }
};

// GET /users/:id
export const getUserById = async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) {
    return res.status(400).json({ error: "user_id must be a number" });
  }

  try {
    const { rows } = await db.query(
      `SELECT ${USER_SAFE_COLUMNS}
       FROM users
       WHERE user_id = $1`,
      [id]
    );

    if (!rows.length) {
      return res.status(404).json({ error: "User not found" });
    }

    const role = Number(req.user.role_id);
    return res.json(attachPlainPasswordIfAllowed(role, rows[0]));
  } catch (err) {
    console.error("Error getting user:", err);
    return res.status(500).json({ error: "Failed to fetch user" });
  }
};

// =============ships history===================
// GET /users/:id/ship-history
export const getUserShipHistory = async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) return res.status(400).json({ error: "user_id must be a number" });

  try {
    const role = Number(req.user.role_id);
    const myCompany = req.user.company_id ? String(req.user.company_id) : null;
    const myShip = req.user.ship_id != null ? Number(req.user.ship_id) : null;

    const uRes = await db.query(
      `SELECT user_id, company_id, ship_id
       FROM users
       WHERE user_id = $1`,
      [id]
    );
    if (!uRes.rows.length) return res.status(404).json({ error: "User not found" });

    const target = uRes.rows[0];

    if (role === 2 && myCompany && String(target.company_id) !== myCompany) {
      return res.status(403).json({ error: "Forbidden (company scope)" });
    }
    if (role === 3) {
      if (myCompany && String(target.company_id) !== myCompany) {
        return res.status(403).json({ error: "Forbidden (company scope)" });
      }
      if (myShip != null && Number(target.ship_id) !== myShip) {
        return res.status(403).json({ error: "Forbidden (ship scope)" });
      }
    }
    if (role === 4 && Number(req.user.user_id) !== Number(id)) {
      return res.status(403).json({ error: "Forbidden" });
    }

    // pagination (min 50 max 100)
    const { page, limit, offset } = getPagination(req, { page: 1, limit: 50 });

    // total count
    const totalRes = await db.query(
      `SELECT COUNT(*)::int AS total
       FROM user_ship_history
       WHERE user_id = $1`,
      [id]
    );
    const total = totalRes.rows[0]?.total ?? 0;

    // paginated data
    const { rows } = await db.query(
      `SELECT
         h.*,
         s.ship_name
       FROM user_ship_history h
       LEFT JOIN ships s ON s.ship_id = h.ship_id
       WHERE h.user_id = $1
       ORDER BY h.created_at DESC
       LIMIT $2 OFFSET $3`,
      [id, limit, offset]
    );

    return res.json({
      user_id: id,
      page,
      limit,
      total,
      count: rows.length,
      history: rows,
    });
  } catch (err) {
    console.error("getUserShipHistory error:", err);
    return res.status(500).json({ error: "Failed to fetch ship history" });
  }
};


// GET /users/by-ship/:ship_id
// roles:
// 1 (superadmin) -> can query any ship
// 2 (admin) -> only ships within their company
// 3 (subadmin/ship admin) -> only their ship (and company)
// 4 (crew) -> forbidden (or you can allow own ship if needed)
export const getUsersByShipId = async (req, res) => {
  try {
    const role = Number(req.user.role_id);
    const ship_id = parseInt(req.params.ship_id, 10);

    if (Number.isNaN(ship_id)) {
      return res.status(400).json({ error: "ship_id must be a number" });
    }

    // block crew (role 4)
    if (role === 4) return res.status(403).json({ error: "Forbidden" });

    // ship lookup (for scope + metadata)
    const shipRes = await db.query(
      `SELECT ship_id, company_id, ship_name
       FROM ships
       WHERE ship_id = $1`,
      [ship_id]
    );
    if (!shipRes.rows.length) return res.status(404).json({ error: "Ship not found" });

    const ship = shipRes.rows[0];

    // scope enforcement
    if (role === 2) {
      if (!req.user.company_id || String(req.user.company_id) !== String(ship.company_id)) {
        return res.status(403).json({ error: "Forbidden (company scope)" });
      }
    }
    if (role === 3) {
      if (!req.user.company_id || String(req.user.company_id) !== String(ship.company_id)) {
        return res.status(403).json({ error: "Forbidden (company scope)" });
      }
      if (req.user.ship_id == null || Number(req.user.ship_id) !== Number(ship_id)) {
        return res.status(403).json({ error: "Forbidden (ship scope)" });
      }
    }

    // ------------------ ✅ Query Params ------------------
    const q = String(req.query.q ?? "").trim();
    const rank = String(req.query.rank ?? "").trim();
    const status = String(req.query.status ?? "").trim();
    const role_id_q = req.query.role_id != null ? Number(req.query.role_id) : null;

    const sort = String(req.query.sort ?? "rank").trim().toLowerCase(); // rank | name | created_at
    const order = String(req.query.order ?? "asc").trim().toLowerCase() === "desc" ? "DESC" : "ASC";

    const { page, limit, offset } = getPagination(req, { page: 1, limit: 100 });

    const where = [
      `u.ship_id = $1`,
      `u.role_id IN (3, 4)` // hide role 1 & 2
    ];
    const params = [ship_id];
    let idx = 2;

    // q search: full_name / seafarer_id / username
    if (q) {
      where.push(`(
        u.full_name ILIKE $${idx}
        OR u.seafarer_id ILIKE $${idx}
        OR u.username ILIKE $${idx}
      )`);
      params.push(`%${q}%`);
      idx++;
    }

    // rank filter (partial match to be friendly)
    if (rank) {
      where.push(`u.rank ILIKE $${idx}`);
      params.push(`%${rank}%`);
      idx++;
    }

    // status filter (Onboard/Offboard)
    if (status) {
      where.push(`LOWER(COALESCE(u.status,'')) = LOWER($${idx})`);
      params.push(status);
      idx++;
    }

    // role_id filter
    if (Number.isFinite(role_id_q)) {
      where.push(`u.role_id = $${idx}`);
      params.push(role_id_q);
      idx++;
    }

    // Sort mapping (avoid SQL injection by whitelisting)
    const sortColumn =
      sort === "name" ? "u.full_name" :
        sort === "created_at" ? "u.created_at" :
          "u.user_id"; // default stable (we'll rank-sort in JS below if you want)

    // total count (for pagination UI)
    const countRes = await db.query(
      `SELECT COUNT(*)::int AS total
       FROM users u
       WHERE ${where.join(" AND ")}`,
      params
    );
    const total = countRes.rows[0]?.total ?? 0;

    // data query
    const dataParams = [...params, limit, offset];
    const { rows } = await db.query(
      `SELECT
         u.user_id,
         u.seafarer_id,
         u.full_name,
         u.rank,
         u.trip,
         u.embarkation_date,
         u.disembarkation_date,
         u.status,
         u.username,
         u.ship_id,
         u.company_id,
         u.created_at,
         u.updated_at,
         u.role_id,
         u.sex,
         u.date_of_birth,
         u.place_of_birth,
         u.nationality,
         u.embarkation_port,
         u.disembarkation_port
       FROM users u
       WHERE ${where.join(" AND ")}
       ORDER BY ${sortColumn} ${order}
       LIMIT $${idx} OFFSET $${idx + 1}`,
      dataParams
    );

    // ✅ If you want your special rank ordering, keep it here:
    // (only makes sense when sort=rank)
    if (sort === "rank") {
      rows.sort((a, b) => {
        const ra = rankSortValue(a.rank);
        const rb = rankSortValue(b.rank);
        if (ra !== rb) return ra - rb;

        const na = String(a.full_name || "").toLowerCase();
        const nb = String(b.full_name || "").toLowerCase();
        return na.localeCompare(nb);
      });
    }

    return res.json({
      ship_id,
      ship_name: ship.ship_name || null,
      company_id: ship.company_id,
      page,
      limit,
      total,
      count: rows.length,
      users: rows,
      applied_filters: {
        q: q || null,
        rank: rank || null,
        status: status || null,
        role_id: Number.isFinite(role_id_q) ? role_id_q : null,
        sort,
        order: order.toLowerCase(),
      },
    });
  } catch (err) {
    console.error("getUsersByShipId error:", err);
    return res.status(500).json({ error: "Failed to fetch users for ship" });
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

// POST /users/sync-status
// Runs daily via Vercel Cron (or manually via Postman).
// Security: either
// 1) x-cron-secret header matches CRON_SECRET env, OR
// 2) Authorization Bearer token of role_id=1 (superadmin)
export const syncUserStatusByDates = async (req, res) => {
  try {
    // Allow either:
    // 1) Vercel cron: /users/sync-status?secret=CRON_SECRET
    // 2) Manual: Authorization Bearer token (superadmin)

    const expected = process.env.CRON_SECRET;

    const secretFromQuery = req.query?.secret;
    const isCronAllowed =
      expected && secretFromQuery && String(secretFromQuery) === String(expected);

    const isSuperAdmin = req.user && Number(req.user.role_id) === 1; // only if requireAuth ran

    if (!isCronAllowed && !isSuperAdmin) {
      return res.status(401).json({ error: "Unauthorized (cron secret or superadmin required)" });
    }

    // ----- Date-based sync rules -----
    const offboardRes = await db.query(
      `UPDATE users
SET
  status = 'Offboard',
  ship_id = NULL,
  updated_at = NOW()
WHERE
  disembarkation_date IS NOT NULL
  AND (embarkation_date IS NULL OR disembarkation_date::date >= embarkation_date::date)
  AND disembarkation_date::date <= CURRENT_DATE
  AND (status IS NULL OR lower(status) <> 'offboard')
RETURNING user_id;
`
    );

    const onboardRes = await db.query(
      `UPDATE users
SET
  status = 'Onboard',
  updated_at = NOW()
WHERE
  ship_id IS NOT NULL
  AND embarkation_date IS NOT NULL
  AND (disembarkation_date IS NULL OR disembarkation_date::date >= embarkation_date::date)
  AND embarkation_date::date <= CURRENT_DATE
  AND (disembarkation_date IS NULL OR disembarkation_date::date > CURRENT_DATE)
  AND (status IS NULL OR lower(status) <> 'onboard')
RETURNING user_id;
`
    );

    return res.json({
      message: "Sync completed",
      today: new Date().toISOString().slice(0, 10),
      offboarded_count: offboardRes.rowCount,
      onboarded_count: onboardRes.rowCount,
      offboarded_user_ids: offboardRes.rows.map((r) => r.user_id),
      onboarded_user_ids: onboardRes.rows.map((r) => r.user_id),
    });
  } catch (err) {
    console.error("syncUserStatusByDates error:", err);
    return res.status(500).json({ error: "Failed to sync user status" });
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

// POST /users/search
export const searchUsers = async (req, res) => {
  try {
    const role = Number(req.user.role_id);

    // incoming filters from body
    const body = req.body || {};
    const q = String(body.q ?? "").trim();
    const rank = String(body.rank ?? "").trim();
    const status = String(body.status ?? "").trim();
    const role_id_q = body.role_id != null ? Number(body.role_id) : null;

    // sorting
    const sort = String(body.sort ?? "rank").trim().toLowerCase(); // rank | name | created_at
    const order =
      String(body.order ?? "asc").trim().toLowerCase() === "desc" ? "DESC" : "ASC";

    // pagination (min10 max100)
    const pageRaw = parseInt(String(body.page ?? "1"), 10);
    const limitRaw = parseInt(String(body.limit ?? "50"), 10);
    const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
    const limit = Math.min(
      100,
      Math.max(50, Number.isFinite(limitRaw) ? limitRaw : 50)
    );
    const offset = (page - 1) * limit;

    // company/ship from body (may be ignored depending on role scope)
    const requestedCompanyId =
      body.company_id != null && String(body.company_id).trim() !== ""
        ? String(body.company_id).trim()
        : null;

    const requestedShipId =
      body.ship_id != null && String(body.ship_id).trim() !== ""
        ? Number.parseInt(String(body.ship_id), 10)
        : null;

    // VALIDATION (only validate when provided)
    // company_id must be UUID (only meaningful for role 1, but validate anyway if sent)
    if (requestedCompanyId && !isUuid(requestedCompanyId)) {
      return res.status(400).json({ error: "company_id must be a valid UUID" });
    }

    // ship_id must be a valid integer when provided
    if (body.ship_id != null && String(body.ship_id).trim() !== "") {
      if (!Number.isInteger(requestedShipId) || requestedShipId <= 0) {
        return res.status(400).json({ error: "ship_id must be a positive integer" });
      }
    }

    // role_id filter must be valid integer if provided
    if (body.role_id != null && !Number.isFinite(role_id_q)) {
      return res.status(400).json({ error: "role_id must be a number" });
    }

    // status validation (optional but nice)
    if (status) {
      const s = String(status).trim().toLowerCase();
      if (s !== "onboard" && s !== "offboard") {
        return res
          .status(400)
          .json({ error: 'status must be either "Onboard" or "Offboard"' });
      }
    }

    // ---------------- WHERE builder ----------------
    const where = [];
    const params = [];
    let p = 1;

    // role scope enforcement
    if (role === 1) {
      // superadmin: optional company filter
      if (requestedCompanyId) {
        where.push(`u.company_id = $${p++}`);
        params.push(requestedCompanyId);
      }
      // optional ship filter
      if (Number.isFinite(requestedShipId)) {
        where.push(`u.ship_id = $${p++}`);
        params.push(requestedShipId);
      }
    } else if (role === 2) {
      // admin: forced company_id from token
      where.push(`u.company_id = $${p++}`);
      params.push(req.user.company_id);

      // optional ship filter (must still be inside company)
      if (Number.isFinite(requestedShipId)) {
        where.push(`u.ship_id = $${p++}`);
        params.push(requestedShipId);
      }
    } else if (role === 3) {
      // subadmin: forced company + ship
      where.push(`u.company_id = $${p++}`);
      params.push(req.user.company_id);

      where.push(`u.ship_id = $${p++}`);
      params.push(req.user.ship_id);
    } else {
      return res.status(403).json({ error: "Forbidden" });
    }
    // Only return Subadmins & Crew
    where.push(`u.role_id IN (3, 4)`);

    // q search
    if (q) {
      where.push(`(
        u.full_name ILIKE $${p}
        OR u.seafarer_id ILIKE $${p}
        OR u.username ILIKE $${p}
      )`);
      params.push(`%${q}%`);
      p++;
    }

    // rank filter
    if (rank) {
      where.push(`u.rank ILIKE $${p++}`);
      params.push(`%${rank}%`);
    }

    // status filter
    if (status) {
      where.push(`LOWER(COALESCE(u.status,'')) = LOWER($${p++})`);
      params.push(status);
    }

    // role_id filter
    if (Number.isFinite(role_id_q)) {
      where.push(`u.role_id = $${p++}`);
      params.push(role_id_q);
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    // whitelist sort column (avoid SQL injection)
    const sortColumn =
      sort === "name" ? "u.full_name" :
        sort === "created_at" ? "u.created_at" :
          "u.user_id";

    // total count
    const totalRes = await db.query(
      `SELECT COUNT(*)::int AS total FROM users u ${whereSql}`,
      params
    );
    const total = totalRes.rows[0]?.total ?? 0;

    // data query
    const dataParams = [...params, limit, offset];
    const { rows } = await db.query(
      `SELECT
         u.user_id,
         u.seafarer_id,
         u.full_name,
         u.rank,
         u.trip,
         u.embarkation_date,
         u.disembarkation_date,
         u.status,
         u.username,
         u.ship_id,
         u.company_id,
         u.created_at,
         u.updated_at,
         u.role_id,
         u.sex,
         u.date_of_birth,
         u.place_of_birth,
         u.nationality,
         u.embarkation_port,
         u.disembarkation_port
       FROM users u
       ${whereSql}
       ORDER BY ${sortColumn} ${order}
       LIMIT $${p} OFFSET $${p + 1}`,
      dataParams
    );

    // ===================== RECENT ACTIVITY (single query for this page) =====================
    // Business rule: green stays for 9 months
    const MONTHS = 9;

    const sinceDate = new Date();
    sinceDate.setMonth(sinceDate.getMonth() - MONTHS);

    const recent_activity_minutes = Math.floor(
      (Date.now() - sinceDate.getTime()) / (60 * 1000)
    );

    let activityMap = new Map(); // user_id -> last_activity_at ISO

    if (rows.length) {
      const ids = rows.map((u) => Number(u.user_id)).filter((n) => Number.isInteger(n));

      if (ids.length) {
        const actRes = await db.query(
          `
      SELECT user_id, MAX(occurred_at) AS last_activity_at
      FROM activity_logs
      WHERE occurred_at >= $1
        AND user_id = ANY($2::int[])
      GROUP BY user_id
      `,
          [sinceDate, ids]
        );

        for (const r of actRes.rows) {
          activityMap.set(
            Number(r.user_id),
            r.last_activity_at ? new Date(r.last_activity_at).toISOString() : null
          );
        }
      }
    }

    // custom rank ordering when sort=rank
    if (sort === "rank") {
      rows.sort((a, b) => {
        const ra = rankSortValue(a.rank);
        const rb = rankSortValue(b.rank);
        if (ra !== rb) return ra - rb;
        return String(a.full_name || "").localeCompare(String(b.full_name || ""), undefined, {
          sensitivity: "base",
        });
      });
    }

    return res.json({
      page,
      limit,
      total,
      count: rows.length,
      recent_activity_minutes: recent_activity_minutes,
      users: rows.map((u) => {
        const last = activityMap.get(Number(u.user_id)) || null;
        return {
          ...u,
          has_recent_activity: !!last,
          last_activity_at: last,
        };
      }),
      applied_filters: {
        company_id: role === 1 ? (requestedCompanyId || null) : String(req.user.company_id),
        ship_id:
          role === 3 ? Number(req.user.ship_id) :
            Number.isFinite(requestedShipId) ? requestedShipId :
              null,
        q: q || null,
        rank: rank || null,
        status: status || null,
        role_id: Number.isFinite(role_id_q) ? role_id_q : null,
        sort,
        order: order.toLowerCase(),
      },
    });
  } catch (err) {
    console.error("searchUsers error:", err);
    return res.status(500).json({ error: "Failed to search users" });
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
  embarkation_date: ["embarkation date", "joining date", "join date", "emb date", "sign on", "sign-on", "start date", "startdate", "start-date", "start - date"],

  disembarkation_port: ["disembarkation port", "sign off port", "leaving port", "disemb port"],
  disembarkation_date: ["disembarkation date", "sign off", "sign-off", "sign off date", "leaving date", "date of joining", "joining date", "disemb date", "end date", "enddate", "end-date", "end - date"],

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

      // ✅ PRELOAD existing users once for the whole sheet (company scope)
      const allSids = Array.from(
        new Set(
          rows
            .map((r) => {
              const sidCandidate = getByAliases(r, FIELD_ALIASES.seafarer_id);
              return sidCandidate != null && String(sidCandidate).trim() !== ""
                ? String(sidCandidate).replace(/\s+/g, " ").trim()
                : null;
            })
            .filter(Boolean)
        )
      );

      const existingAllRes =
        allSids.length > 0
          ? await db.query(
            `SELECT user_id, seafarer_id, ship_id
         FROM users
         WHERE company_id = $1 AND seafarer_id = ANY($2::text[])`,
            [company_id, allSids]
          )
          : { rows: [] };

      // Map seafarer_id -> existing user row
      const existingMap = new Map();
      for (const u of existingAllRes.rows) {
        existingMap.set(String(u.seafarer_id), u);
      }


      const results = {
        import_scope: { company_id, ship_id },
        detected_sheet: sheetName,
        detected_header_row: headerRowIdx + 1,
        total_rows: rows.length,
        inserted: 0,
        updated: 0,
        skipped: 0,
        errors: [],
        created_credentials: [],
      };
      await db.query("BEGIN");
      const CHUNK_SIZE = 50; // or 25 if big Excel
      for (let start = 0; start < rows.length; start += CHUNK_SIZE) {
        const chunk = rows.slice(start, start + CHUNK_SIZE);

        for (let i = 0; i < chunk.length; i++) {
          const r = chunk[i];
          const rowNum = headerRowIdx + 2 + (start + i);

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

          // ✅ Fix invalid ranges coming from Excel (disembark < embark)
          let emb = embarkation_date;
          let dis = disembarkation_date;
          // ✅ Safety: never allow NaN to flow into DB params
          if (emb !== null && Number.isNaN(emb)) emb = null;
          if (dis !== null && Number.isNaN(dis)) dis = null;

          if (emb && dis) {
            const embD = new Date(emb);
            const disD = new Date(dis);
            if (!Number.isNaN(embD.getTime()) && !Number.isNaN(disD.getTime()) && disD < embD) {
              dis = null;
            }
          }


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
              : computeStatusFromDates({ disembarkation_date: dis });

          // ✅ Auto role assignment:
          // If rank is senior → role_id=3 + force Onboard
          const role_id_to_insert = isShipAdminRank(rank) ? 3 : 4;

          if (role_id_to_insert === 3 && ship_id) {
            status = "Onboard";
          }

          // ✅ If this user already exists in same company, UPDATE instead of INSERT
          const existingUser = existingMap.get(seafarer_id) || null;

          const dateFieldsForUpdate = [
            ["date_of_birth", date_of_birth],
            ["embarkation_date", emb],
            ["disembarkation_date", dis],
            ["end_of_contract", end_of_contract],
            ["passport_issue_date", passport_issue_date],
            ["passport_expiry_date", passport_expiry_date],
            ["seaman_book_issue_date", seaman_book_issue_date],
            ["seaman_book_expiry_date", seaman_book_expiry_date],
          ];

          // if any is NaN (shouldn't happen after fix, but guard anyway)
          const badDateUpdate = dateFieldsForUpdate.find(([, v]) => v !== null && Number.isNaN(v));
          if (badDateUpdate) {
            results.skipped++;
            results.errors.push({ row: rowNum, error: `Invalid date in ${badDateUpdate[0]}` });
            continue;
          }

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

       sex = COALESCE($10, sex),
       date_of_birth = COALESCE($11, date_of_birth),
       place_of_birth = COALESCE($12, place_of_birth),
       nationality = COALESCE($13, nationality),

       end_of_contract = COALESCE($14, end_of_contract),
       plus_months = COALESCE($15, plus_months),

       passport_number = COALESCE($16, passport_number),
       passport_issue_place = COALESCE($17, passport_issue_place),
       passport_issue_date = COALESCE($18, passport_issue_date),
       passport_expiry_date = COALESCE($19, passport_expiry_date),

       seaman_book_number = COALESCE($20, seaman_book_number),
       seaman_book_issue_date = COALESCE($21, seaman_book_issue_date),
       seaman_book_expiry_date = COALESCE($22, seaman_book_expiry_date),

       updated_at = NOW()
     WHERE user_id = $23`,
              [
                full_name,
                rank ?? null,
                ship_id,
                status,
                emb ?? null,
                dis ?? null,
                embarkation_port ?? null,
                disembarkation_port ?? null,
                role_id_to_insert,

                sex ?? null,
                date_of_birth ?? null,
                place_of_birth ?? null,
                nationality ?? null,

                end_of_contract ?? null,
                plus_months ?? null,

                passport_number ?? null,
                passport_issue_place ?? null,
                passport_issue_date ?? null,
                passport_expiry_date ?? null,

                seaman_book_number ?? null,
                seaman_book_issue_date ?? null,
                seaman_book_expiry_date ?? null,

                existingUser.user_id,
              ]
            );

            const oldShip = existingUser.ship_id ?? null;
            const newShip = ship_id;

            await handleShipHistoryChange({
              user_id: existingUser.user_id,
              company_id,
              old_ship_id: oldShip,
              new_ship_id: newShip,
              embarkation_date: emb,
              disembarkation_date: dis,
              embarkation_port,
              disembarkation_port,
              changed_by_user_id: req.user.user_id,
              notes: "Excel import (existing user ship update)",
            });

            // keep in-memory map fresh
            existingMap.set(seafarer_id, {
              user_id: existingUser.user_id,
              seafarer_id,
              ship_id: newShip,
            });

            results.updated++;
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
            ["embarkation_date", emb],
            ["disembarkation_date", dis],
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

                emb ?? null,
                dis ?? null,
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

                role_id_to_insert,
              ]
            );

            const insertedUserId = inserted[0]?.user_id;

            // ✅ update in-memory map so if same seafarer_id appears again in this sheet, it will be treated as existing
            existingMap.set(seafarer_id, { user_id: insertedUserId, seafarer_id, ship_id });


            await handleShipHistoryChange({
              user_id: insertedUserId,
              company_id,
              old_ship_id: null,
              new_ship_id: ship_id,
              embarkation_date: emb,
              disembarkation_date: dis,
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
      }

      await db.query("COMMIT");

      return res.status(201).json({
        message: "Excel import completed",
        ...results,
      });
    } catch (err) {
      try { await db.query("ROLLBACK"); } catch { }
      console.error("importUsersFromExcel error:", err);
      return res.status(500).json({ error: "Failed to import users" });
    }
  },
];
