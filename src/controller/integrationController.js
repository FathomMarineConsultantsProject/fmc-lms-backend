import { google } from "googleapis";
import { db } from "../db.js";
import crypto from "crypto";

const ENC_KEY = process.env.OAUTH_ENC_KEY;

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

const zoomAuthUrl = () => "https://zoom.us/oauth/authorize";
const zoomTokenUrl = () => "https://zoom.us/oauth/token";
const msAuthUrl = (tenant) => `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`;
const msTokenUrl = (tenant) => `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`;

function buildState(req) {
  return Buffer.from(
    JSON.stringify({
      company_id: req.user.company_id,
      user_id: req.user.user_id,
    })
  ).toString("base64url");
}

function parseState(state) {
  return JSON.parse(Buffer.from(String(state), "base64url").toString("utf8"));
}

async function upsertOAuthConnection({
  company_id,
  user_id,
  provider,
  access_token,
  refresh_token,
  expires_at,
}) {
  const access_enc = access_token ? encrypt(access_token) : null;
  const refresh_enc = refresh_token ? encrypt(refresh_token) : null;

  await db.query(
    `
    INSERT INTO public.oauth_connections
      (company_id, user_id, provider, access_token_enc, refresh_token_enc, token_expires_at, updated_at)
    VALUES
      ($1, $2, $3, $4, $5, $6, NOW())
    ON CONFLICT (user_id, provider)
    DO UPDATE SET
      company_id = EXCLUDED.company_id,
      access_token_enc = EXCLUDED.access_token_enc,
      refresh_token_enc = COALESCE(EXCLUDED.refresh_token_enc, public.oauth_connections.refresh_token_enc),
      token_expires_at = EXCLUDED.token_expires_at,
      updated_at = NOW()
    `,
    [company_id, user_id, provider, access_enc, refresh_enc, expires_at]
  );
}

async function getOAuthRow(user_id, provider) {
  const r = await db.query(
    `
    SELECT access_token_enc, refresh_token_enc, token_expires_at
    FROM public.oauth_connections
    WHERE user_id = $1 AND provider = $2
    `,
    [user_id, provider]
  );

  if (r.rowCount === 0) {
    throw new Error(`${provider} not connected`);
  }

  return r.rows[0];
}

/* ---------------- GOOGLE ---------------- */

export async function googleConnect(req, res) {
  const oauth2Client = googleOAuthClient();
  const scopes = ["https://www.googleapis.com/auth/calendar.events"];
  const state = buildState(req);

  const url = oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: scopes,
    state,
  });

  if (req.query.mode === "json") return res.json({ url });
  return res.redirect(url);
}

export async function googleCallback(req, res) {
  try {
    const { code, state } = req.query;
    if (!code || !state) return res.status(400).send("Missing code/state");

    const parsed = parseState(state);
    const company_id = String(parsed.company_id);
    const user_id = Number(parsed.user_id);

    const oauth2Client = googleOAuthClient();
    const { tokens } = await oauth2Client.getToken(String(code));

    const expires_at = tokens.expiry_date ? new Date(tokens.expiry_date) : null;

    await upsertOAuthConnection({
      company_id,
      user_id,
      provider: "google",
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at,
    });

    return res.send("✅ Google connected successfully. You can close this tab.");
  } catch (err) {
    console.error("googleCallback:", err);
    return res.status(500).send("Google callback failed");
  }
}

export async function googleStatus(req, res) {
  const user_id = req.user.user_id;
  const r = await db.query(
    `SELECT token_expires_at
     FROM public.oauth_connections
     WHERE user_id = $1 AND provider = 'google'`,
    [user_id]
  );

  return res.json({ connected: r.rowCount > 0, data: r.rows[0] || null });
}

export async function getGoogleAccessToken(user_id) {
  const row = await getOAuthRow(user_id, "google");

  let access = row.access_token_enc ? decrypt(row.access_token_enc) : null;
  const refresh = row.refresh_token_enc ? decrypt(row.refresh_token_enc) : null;

  const expired =
    row.token_expires_at &&
    new Date(row.token_expires_at).getTime() <= Date.now() + 30000;

  if (!access || expired) {
    const oauth2Client = googleOAuthClient();
    oauth2Client.setCredentials({ refresh_token: refresh });

    const { credentials } = await oauth2Client.refreshAccessToken();
    access = credentials.access_token;

    const expires_at = credentials.expiry_date ? new Date(credentials.expiry_date) : null;

    await db.query(
      `
      UPDATE public.oauth_connections
      SET access_token_enc = $2,
          token_expires_at = $3,
          updated_at = NOW()
      WHERE user_id = $1 AND provider = 'google'
      `,
      [user_id, encrypt(access), expires_at]
    );
  }

  return access;
}

/* ---------------- ZOOM ---------------- */

export async function zoomConnect(req, res) {
  const state = buildState(req);

  const params = new URLSearchParams({
    response_type: "code",
    client_id: process.env.ZOOM_CLIENT_ID,
    redirect_uri: process.env.ZOOM_REDIRECT_URI,
    state,
  });

  const url = `${zoomAuthUrl()}?${params.toString()}`;
  if (req.query.mode === "json") return res.json({ url });
  return res.redirect(url);
}

export async function zoomCallback(req, res) {
  try {
    const { code, state } = req.query;
    if (!code || !state) return res.status(400).send("Missing code/state");

    const parsed = parseState(state);
    const company_id = String(parsed.company_id);
    const user_id = Number(parsed.user_id);

    const basic = Buffer.from(
      `${process.env.ZOOM_CLIENT_ID}:${process.env.ZOOM_CLIENT_SECRET}`
    ).toString("base64");

    const tokenParams = new URLSearchParams({
      grant_type: "authorization_code",
      code: String(code),
      redirect_uri: process.env.ZOOM_REDIRECT_URI,
    });

    const tokenRes = await fetch(`${zoomTokenUrl()}?${tokenParams.toString()}`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
      },
    });

    const tokenJson = await tokenRes.json();
    if (!tokenRes.ok) {
      console.error("Zoom token error:", tokenJson);
      return res.status(500).send("Zoom token exchange failed");
    }

    const expires_at = tokenJson.expires_in
      ? new Date(Date.now() + Number(tokenJson.expires_in) * 1000)
      : null;

    await upsertOAuthConnection({
      company_id,
      user_id,
      provider: "zoom",
      access_token: tokenJson.access_token,
      refresh_token: tokenJson.refresh_token,
      expires_at,
    });

    return res.send("✅ Zoom connected successfully. You can close this tab.");
  } catch (err) {
    console.error("zoomCallback:", err);
    return res.status(500).send("Zoom callback failed");
  }
}

export async function zoomStatus(req, res) {
  const user_id = req.user.user_id;
  const r = await db.query(
    `SELECT token_expires_at
     FROM public.oauth_connections
     WHERE user_id = $1 AND provider = 'zoom'`,
    [user_id]
  );

  return res.json({ connected: r.rowCount > 0, data: r.rows[0] || null });
}

export async function getZoomAccessToken(user_id) {
  const row = await getOAuthRow(user_id, "zoom");

  let access = row.access_token_enc ? decrypt(row.access_token_enc) : null;
  const refresh = row.refresh_token_enc ? decrypt(row.refresh_token_enc) : null;

  const expired =
    row.token_expires_at &&
    new Date(row.token_expires_at).getTime() <= Date.now() + 30000;

  if (!access || expired) {
    const basic = Buffer.from(
      `${process.env.ZOOM_CLIENT_ID}:${process.env.ZOOM_CLIENT_SECRET}`
    ).toString("base64");

    const refreshParams = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refresh,
    });

    const refreshRes = await fetch(`${zoomTokenUrl()}?${refreshParams.toString()}`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
      },
    });

    const refreshJson = await refreshRes.json();
    if (!refreshRes.ok) {
      throw new Error(refreshJson?.reason || "Zoom refresh failed");
    }

    access = refreshJson.access_token;
    const expires_at = refreshJson.expires_in
      ? new Date(Date.now() + Number(refreshJson.expires_in) * 1000)
      : null;

    await db.query(
      `
      UPDATE public.oauth_connections
      SET access_token_enc = $2,
          refresh_token_enc = COALESCE($3, refresh_token_enc),
          token_expires_at = $4,
          updated_at = NOW()
      WHERE user_id = $1 AND provider = 'zoom'
      `,
      [
        user_id,
        encrypt(access),
        refreshJson.refresh_token ? encrypt(refreshJson.refresh_token) : null,
        expires_at,
      ]
    );
  }

  return access;
}

/* ---------------- TEAMS ---------------- */

export async function teamsConnect(req, res) {
  const tenant = process.env.MS_TENANT_ID;
  const scope =
    process.env.MS_OAUTH_SCOPES ||
    "offline_access openid profile User.Read OnlineMeetings.ReadWrite Calendars.ReadWrite";

  const state = buildState(req);

  const params = new URLSearchParams({
    client_id: process.env.MS_CLIENT_ID,
    response_type: "code",
    redirect_uri: process.env.MS_REDIRECT_URI,
    response_mode: "query",
    scope,
    state,
  });

  const url = `${msAuthUrl(tenant)}?${params.toString()}`;
  if (req.query.mode === "json") return res.json({ url });
  return res.redirect(url);
}

export async function teamsCallback(req, res) {
  try {
    const { code, state } = req.query;
    if (!code || !state) return res.status(400).send("Missing code/state");

    const parsed = parseState(state);
    const company_id = String(parsed.company_id);
    const user_id = Number(parsed.user_id);
    const tenant = process.env.MS_TENANT_ID;

    const body = new URLSearchParams({
      client_id: process.env.MS_CLIENT_ID,
      client_secret: process.env.MS_CLIENT_SECRET,
      grant_type: "authorization_code",
      code: String(code),
      redirect_uri: process.env.MS_REDIRECT_URI,
    });

    const tokenRes = await fetch(msTokenUrl(tenant), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });

    const tokenJson = await tokenRes.json();
    if (!tokenRes.ok) {
      console.error("MS token error:", tokenJson);
      return res.status(500).send("Teams token exchange failed");
    }

    const expires_at = tokenJson.expires_in
      ? new Date(Date.now() + Number(tokenJson.expires_in) * 1000)
      : null;

    await upsertOAuthConnection({
      company_id,
      user_id,
      provider: "teams",
      access_token: tokenJson.access_token,
      refresh_token: tokenJson.refresh_token,
      expires_at,
    });

    return res.send("✅ Teams connected successfully. You can close this tab.");
  } catch (err) {
    console.error("teamsCallback:", err);
    return res.status(500).send("Teams callback failed");
  }
}

export async function teamsStatus(req, res) {
  const user_id = req.user.user_id;
  const r = await db.query(
    `SELECT token_expires_at
     FROM public.oauth_connections
     WHERE user_id = $1 AND provider = 'teams'`,
    [user_id]
  );

  return res.json({ connected: r.rowCount > 0, data: r.rows[0] || null });
}

export async function getTeamsAccessToken(user_id) {
  const row = await getOAuthRow(user_id, "teams");

  let access = row.access_token_enc ? decrypt(row.access_token_enc) : null;
  const refresh = row.refresh_token_enc ? decrypt(row.refresh_token_enc) : null;

  const expired =
    row.token_expires_at &&
    new Date(row.token_expires_at).getTime() <= Date.now() + 30000;

  if (!access || expired) {
    const tenant = process.env.MS_TENANT_ID;

    const body = new URLSearchParams({
      client_id: process.env.MS_CLIENT_ID,
      client_secret: process.env.MS_CLIENT_SECRET,
      grant_type: "refresh_token",
      refresh_token: refresh,
      redirect_uri: process.env.MS_REDIRECT_URI,
    });

    const refreshRes = await fetch(msTokenUrl(tenant), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });

    const refreshJson = await refreshRes.json();
    if (!refreshRes.ok) {
      throw new Error(refreshJson?.error_description || "Teams refresh failed");
    }

    access = refreshJson.access_token;
    const expires_at = refreshJson.expires_in
      ? new Date(Date.now() + Number(refreshJson.expires_in) * 1000)
      : null;

    await db.query(
      `
      UPDATE public.oauth_connections
      SET access_token_enc = $2,
          refresh_token_enc = COALESCE($3, refresh_token_enc),
          token_expires_at = $4,
          updated_at = NOW()
      WHERE user_id = $1 AND provider = 'teams'
      `,
      [
        user_id,
        encrypt(access),
        refreshJson.refresh_token ? encrypt(refreshJson.refresh_token) : null,
        expires_at,
      ]
    );
  }

  return access;
}