import { db } from "../db.js";
import { sendEmail, isValidEmail } from "../utils/mailer.js";
import {
  buildSingleCredentialEmail,
  buildBulkCredentialEmail,
} from "../utils/credentialTemplates.js";
import { rankSortValue } from "../utils/rankSort.js";

// TODO: import your existing decrypt helper from wherever you have it
import { decryptPassword } from "../utils/cryptoPasswords.js";
// If you don't have this file, create it and move decrypt logic there.

// Prevent sending creds for these roles
const DISALLOWED_TARGET_ROLES = new Set([1, 2]); // allow 3 & 4

const assertCanAccessUser = (requester, targetUser) => {
  const role = Number(requester.role_id);

  if (role === 1) return true;

  const reqCompany = requester.company_id ? String(requester.company_id) : null;
  const tgtCompany = targetUser.company_id ? String(targetUser.company_id) : null;

  if (role === 2) {
    return reqCompany && tgtCompany && reqCompany === tgtCompany;
  }

  if (role === 3) {
    const reqShip = requester.ship_id != null ? Number(requester.ship_id) : null;
    const tgtShip = targetUser.ship_id != null ? Number(targetUser.ship_id) : null;

    return reqCompany && tgtCompany && reqCompany === tgtCompany && reqShip != null && tgtShip != null && reqShip === tgtShip;
  }

  return false;
};

const fetchUserForCredentials = async (user_id) => {
  const { rows } = await db.query(
    `
    SELECT 
      u.user_id,
      u.seafarer_id,     -- ✅ for template column
      u.company_id,
      u.ship_id,
      u.role_id,
      u.username,
      u.password_enc as password_encrypted,
      u.full_name,
      u.rank,
      u.rank AS rank_name               -- ✅ for template column
    FROM users u
    WHERE u.user_id = $1
    `,
    [user_id]
  );
  return rows[0];
};

const fetchCompanyName = async (company_id) => {
  if (!company_id) return null;
  const { rows } = await db.query("SELECT company_name FROM company WHERE company_id=$1", [company_id]);
  return rows[0]?.company_name || null;
};

const logMailEvent = async ({ requester, actor_user_id, activity_type, payload }) => {
  try {
    await db.query(
      `
      INSERT INTO activity_logs
        (user_id, username, company_id, ship_id, activity_type, training_type, payload_json, occurred_at, created_at)
      VALUES
        ($1, $2, $3, $4, $5, NULL, $6, NOW(), NOW())
      `,
      [
        actor_user_id,
        requester?.username || null,
        requester?.company_id || null,
        requester?.ship_id || null,
        activity_type,
        JSON.stringify(payload || {}),
      ]
    );
  } catch (e) {
    console.warn("activity_logs insert failed:", e?.message || e);
  }
};


// POST /api/users/send-credentials
export const sendCredentialsSingle = async (req, res) => {
  try {
    const requester = req.user;
    const role = Number(requester.role_id);
    if (![1, 2].includes(role)) {
      return res.status(403).json({ error: "Not allowed." });
    }

    const { user_id, email } = req.body;
    if (!user_id) return res.status(400).json({ error: "user_id is required." });
    if (!email || !isValidEmail(email)) {
      return res.status(400).json({ error: "Valid email is required." });
    }

    const target = await fetchUserForCredentials(user_id);
    if (!target) return res.status(404).json({ error: "User not found." });

    if (DISALLOWED_TARGET_ROLES.has(Number(target.role_id))) {
      return res.status(400).json({ error: "Cannot send credentials for this user role." });
    }

    if (!assertCanAccessUser(requester, target)) {
      return res.status(403).json({ error: "Out of scope." });
    }

    if (!target.password_encrypted) {
      return res.status(400).json({ error: "User password not available." });
    }

    const plain_password = decryptPassword(target.password_encrypted);

    const companyName = await fetchCompanyName(target.company_id);

    const { subject, html } = buildSingleCredentialEmail({
      companyName,
      row: { ...target, plain_password },
    });

    await sendEmail({ to: email, subject, html });

    await logMailEvent({
      requester,
      actor_user_id: requester.user_id,
      activity_type: "SEND_CREDENTIALS_SINGLE",
      payload: { target_user_id: target.user_id, to: email },
    });

    return res.json({ message: "Mail sent successfully." });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to send mail." });
  }
};

// POST /api/users/send-credentials/bulk
export const sendCredentialsBulk = async (req, res) => {
  try {
    const requester = req.user;
    const role = Number(requester.role_id);
    if (![1, 2].includes(role)) {
      return res.status(403).json({ error: "Only admins can send bulk credentials." });
    }

    const { user_ids, email } = req.body;
    if (!Array.isArray(user_ids) || user_ids.length === 0) {
      return res.status(400).json({ error: "user_ids array is required." });
    }
    if (!email || !isValidEmail(email)) {
      return res.status(400).json({ error: "Valid email is required." });
    }

    // Fetch users in one query
    const { rows } = await db.query(
      `
  SELECT 
    u.user_id,
    u.seafarer_id,      -- ✅ for template
    u.company_id,
    u.ship_id,
    u.role_id,
    u.username,
    u.password_enc AS password_encrypted,
    u.full_name,
    u.rank,
    u.rank                -- ✅ for template
  FROM users u
  WHERE u.user_id = ANY($1::int[])
  `,
      [user_ids]
    );

    // Filter to same company + allowed role
    const allowed = rows
      .filter((u) => (role === 1 ? true : String(u.company_id) === String(requester.company_id)))
      .filter((u) => !DISALLOWED_TARGET_ROLES.has(Number(u.role_id)))
      .filter((u) => u.password_encrypted);

    const companyName = await fetchCompanyName(requester.company_id);

    const rowsWithPlain = allowed.map((u) => ({
      ...u,
      plain_password: decryptPassword(u.password_encrypted),
    }));

    // ✅ sort rank first, then name
    rowsWithPlain.sort((a, b) => {
      const ra = rankSortValue(a.rank);
      const rb = rankSortValue(b.rank);
      if (ra !== rb) return ra - rb;

      return String(a.full_name || "").localeCompare(String(b.full_name || ""), undefined, {
        sensitivity: "base",
      });
    });

    const { subject, html } = buildBulkCredentialEmail({
      companyName,
      rows: rowsWithPlain,
    });

    await sendEmail({ to: email, subject, html });

    await logMailEvent({
      requester,
      actor_user_id: requester.user_id,
      activity_type: "SEND_CREDENTIALS_BULK",
      payload: { count: rowsWithPlain.length, to: email, requested_ids: user_ids },
    });



    return res.json({
      message: "Bulk mail sent successfully.",
      sent_count: rowsWithPlain.length,
      skipped_count: user_ids.length - rowsWithPlain.length,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to send bulk mail." });
  }
};


const roleName = (roleId) => {
  const r = Number(roleId);
  if (r === 1) return "Superadmin";
  if (r === 2) return "Admin";
  if (r === 3) return "Subadmin";
  return "Crew";
};

// GET /mail/support-template
export const getSupportMailTemplate = async (req, res) => {
  try {
    const me = req.user; // from requireAuth

    // fetch ship + company names (optional, but nice)
    const shipRes =
      me.ship_id != null
        ? await db.query(`SELECT ship_name FROM ships WHERE ship_id = $1 LIMIT 1`, [me.ship_id])
        : { rows: [] };

    const compRes =
      me.company_id
        ? await db.query(`SELECT company_name FROM company WHERE company_id = $1 LIMIT 1`, [me.company_id])
        : { rows: [] };

    const shipName = shipRes.rows[0]?.ship_name || "";
    const companyName = compRes.rows[0]?.company_name || "";

    const to = "contact@fathommarineconsultants.com";
    const subject = "Support Request - FMC LMS";

    const body = `Hello FMC Support Team,

My Name: ${me.full_name || ""}
Username: ${me.username || ""}
Role: ${roleName(me.role_id)}
Company: ${companyName}
Ship: ${shipName}

Issue Type:
[ ] Login Issue
[ ] Crew Management
[ ] Assessment
[ ] Certificates
[ ] Other

Description of the Issue:
--------------------------------------------------
(Write your issue here)

Steps to Reproduce:
1.
2.
3.

Expected Result:

Actual Result:

Date & Time of Issue:

Attachments (if any):
--------------------------------------------------

Thank you,
${me.full_name || ""}
`;

    return res.json({ to, subject, body });
  } catch (err) {
    console.error("getSupportMailTemplate error:", err);
    return res.status(500).json({ error: "Failed to generate support mail template" });
  }
};
