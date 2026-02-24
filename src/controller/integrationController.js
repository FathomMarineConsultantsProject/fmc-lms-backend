import { google } from "googleapis";
import { db } from "../db.js";
import crypto from "crypto";

const ENC_KEY = process.env.OAUTH_ENC_KEY; // exactly 32 chars

function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const key = Buffer.from(ENC_KEY, "utf8");
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64");
}

function decrypt(b64) {
  const buf = Buffer.from(b64, "base64");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const enc = buf.subarray(28);
  const key = Buffer.from(ENC_KEY, "utf8");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(enc, null, "utf8") + decipher.final("utf8");
}

function googleOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
}

/**
 * Redirect user to Google consent screen
 */
export async function googleConnect(req, res) {
  const oauth2Client = googleOAuthClient();

  const scopes = ["https://www.googleapis.com/auth/calendar.events"];

  // simplest state: company_id (later can sign JWT)
  const state = String(req.user.company_id);

  const url = oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent", // ensures refresh_token
    scope: scopes,
    state,
  });

  return res.redirect(url);
}

/**
 * Google redirects here after consent
 * We exchange code -> tokens and store encrypted
 */
export async function googleCallback(req, res) {
  try {
    const { code, state } = req.query;
    if (!code || !state) return res.status(400).send("Missing code/state");

    const company_id = String(state);
    const oauth2Client = googleOAuthClient();

    const { tokens } = await oauth2Client.getToken(String(code));

    const access_enc = tokens.access_token ? encrypt(tokens.access_token) : null;
    const refresh_enc = tokens.refresh_token ? encrypt(tokens.refresh_token) : null;
    const expires_at = tokens.expiry_date ? new Date(tokens.expiry_date) : null;

    await db.query(
      `
      INSERT INTO public.oauth_connections
      (company_id, provider, access_token_enc, refresh_token_enc, token_expires_at)
      VALUES ($1,'google',$2,$3,$4)
      ON CONFLICT (company_id, provider)
      DO UPDATE SET
        access_token_enc = EXCLUDED.access_token_enc,
        refresh_token_enc = COALESCE(EXCLUDED.refresh_token_enc, public.oauth_connections.refresh_token_enc),
        token_expires_at = EXCLUDED.token_expires_at,
        updated_at = NOW()
      `,
      [company_id, access_enc, refresh_enc, expires_at]
    );

    return res.send("✅ Google connected successfully. You can close this tab.");
  } catch (err) {
    console.error("googleCallback:", err);
    return res.status(500).send("Google callback failed");
  }
}

/**
 * For FE: check if Google is connected
 */
export async function googleStatus(req, res) {
  const company_id = req.user.company_id;
  const r = await db.query(
    `SELECT token_expires_at FROM public.oauth_connections WHERE company_id=$1 AND provider='google'`,
    [company_id]
  );
  return res.json({ connected: r.rowCount > 0, data: r.rows[0] || null });
}

/**
 * INTERNAL: get valid access token (refresh when expired)
 */
export async function getGoogleAccessToken(company_id) {
  const r = await db.query(
    `SELECT access_token_enc, refresh_token_enc, token_expires_at
     FROM public.oauth_connections
     WHERE company_id=$1 AND provider='google'`,
    [company_id]
  );
  if (r.rowCount === 0) throw new Error("Google not connected");

  const row = r.rows[0];
  let access = row.access_token_enc ? decrypt(row.access_token_enc) : null;
  const refresh = row.refresh_token_enc ? decrypt(row.refresh_token_enc) : null;

  const expired =
    row.token_expires_at && new Date(row.token_expires_at).getTime() <= Date.now() + 30_000;

  if (!access || expired) {
    const oauth2Client = googleOAuthClient();
    oauth2Client.setCredentials({ refresh_token: refresh });

    const { credentials } = await oauth2Client.refreshAccessToken();
    access = credentials.access_token;

    const expires_at = credentials.expiry_date ? new Date(credentials.expiry_date) : null;

    await db.query(
      `UPDATE public.oauth_connections
       SET access_token_enc=$2, token_expires_at=$3, updated_at=NOW()
       WHERE company_id=$1 AND provider='google'`,
      [company_id, encrypt(access), expires_at]
    );
  }

  return access;
}