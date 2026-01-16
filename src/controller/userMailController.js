import { db } from "../db.js";
import { sendEmail, isValidEmail } from "../utils/mailer.js";
import {
  buildSingleCredentialEmail,
  buildBulkCredentialEmail,
} from "../utils/credentialTemplates.js";

// TODO: import your existing decrypt helper from wherever you have it
import { decryptPassword } from "../utils/cryptoPasswords.js"; 
// If you don't have this file, create it and move decrypt logic there.

// Prevent sending creds for these roles
const DISALLOWED_TARGET_ROLES = new Set([1, 2, 3]); // Only crew should be mailed typically (role 4)

const assertCanAccessUser = (requester, targetUser) => {
  const role = Number(requester.role_id);
  if (role === 1) return true; // if you ever allow superadmin
  if (role === 2) return Number(targetUser.company_id) === Number(requester.company_id);
  if (role === 3)
    return (
      Number(targetUser.company_id) === Number(requester.company_id) &&
      Number(targetUser.ship_id) === Number(requester.ship_id)
    );
  return false;
};

const fetchUserForCredentials = async (user_id) => {
  // Adjust fields to match your schema
  const { rows } = await db.query(
    `
    SELECT 
      u.user_id,
      u.company_id,
      u.ship_id,
      u.role_id,
      u.username,
      u.password_enc as password_encrypted,
      u.employee_no,
      u.full_name,
      u.rank_name
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

const logMailEvent = async ({ actor_user_id, action, meta }) => {
  // If you already log activity in activity_logs, do it here
  // Adjust columns to your table
  await db.query(
    `
    INSERT INTO activity_logs (user_id, action, meta, created_at)
    VALUES ($1, $2, $3, NOW())
    `,
    [actor_user_id, action, JSON.stringify(meta || {})]
  );
};

// POST /api/users/send-credentials
export const sendCredentialsSingle = async (req, res) => {
  try {
    const requester = req.user;
    const role = Number(requester.role_id);
    if (![2, 3].includes(role)) {
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
      actor_user_id: requester.user_id,
      action: "SEND_CREDENTIALS_SINGLE",
      meta: { target_user_id: target.user_id, to: email },
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
    if (role !== 2) {
      return res.status(403).json({ error: "Only company admin can send bulk credentials." });
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
        u.company_id,
        u.ship_id,
        u.role_id,
        u.username,
        u.password_enc as password_encrypted,
        u.employee_no,
        u.full_name,
        u.rank_name
      FROM users u
      WHERE u.user_id = ANY($1::int[])
      `,
      [user_ids]
    );

    // Filter to same company + allowed role
    const allowed = rows
      .filter((u) => Number(u.company_id) === Number(requester.company_id))
      .filter((u) => !DISALLOWED_TARGET_ROLES.has(Number(u.role_id)))
      .filter((u) => u.password_encrypted);

    const companyName = await fetchCompanyName(requester.company_id);

    const rowsWithPlain = allowed.map((u) => ({
      ...u,
      plain_password: decryptPassword(u.password_encrypted),
    }));

    const { subject, html } = buildBulkCredentialEmail({
      companyName,
      rows: rowsWithPlain,
    });

    await sendEmail({ to: email, subject, html });

    await logMailEvent({
      actor_user_id: requester.user_id,
      action: "SEND_CREDENTIALS_BULK",
      meta: { count: rowsWithPlain.length, to: email, requested_ids: user_ids },
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



