// src/controller/meetingController.js
import { db } from "../db.js";
import { createGoogleMeetEvent } from "../providers/googleMeet.js";
import { createZoomMeeting } from "../providers/zoomMeet.js";
import { createTeamsMeeting } from "../providers/teamsMeet.js";

/**
 * Helper: get scope from req.user safely.
 * Your requireAuth usually sets req.user fields.
 * We use company_id for scoping, and ship_id if role is subadmin.
 */
function getUserScope(req) {
  const u = req.user || {};
  return {
    role_id: u.role_id,
    company_id: u.company_id, // company.company_id is UUID in your DB
    ship_id: u.ship_id, // ships.ship_id is int4 in your DB
    user_id: u.user_id, // users.user_id is int4 in your DB
  };
}

/**
 * Helper: Apply RBAC scope rules in SQL WHERE.
 * - role 1 (superadmin): no extra filter
 * - role 2 (admin): company scope
 * - role 3 (subadmin): company + ship scope
 * - role 4 (crew): company + ship scope (and maybe created_by / attendee-only, later)
 */
function buildScopeWhere({ role_id, company_id, ship_id }) {
  if (role_id === 1) return { sql: "1=1", params: [] }; // all
  if (role_id === 2) return { sql: "m.company_id = $1", params: [company_id] };
  // role 3 & 4 → company + ship (if ship_id exists)
  return {
    sql: "m.company_id = $1 AND (m.ship_id = $2 OR $2 IS NULL OR m.ship_id IS NULL)",
    params: [company_id, ship_id ?? null],
  };
}

/**
 * POST /meetings
 * Creates a meeting.
 * Body:
 * {
 *   title, description, department, course_title,
 *   scheduled_at, duration_minutes,
 *   priority, meeting_type,
 *   meeting_link,
 *   send_invitations,
 *   ship_id (optional),
 *   attendees: ["a@x.com","b@x.com"] (optional),
 *   platform: "manual" | "google" | "zoom" | "teams"
 * }
 */
export async function createMeeting(req, res) {
  try {
    const { role_id, company_id, ship_id: userShipId, user_id } = getUserScope(req);

    const {
      title,
      description = null,
      department,
      course_title = null,
      scheduled_at,
      duration_minutes = 60,
      priority = "medium",
      meeting_type,
      meeting_link = null,
      send_invitations = false,
      ship_id = null,
      attendees = [],
      platform = "manual", // 'manual' | 'google' | 'zoom'
    } = req.body || {};

    // Basic validation
    if (!title || !department || !scheduled_at || !meeting_type) {
      return res.status(400).json({
        error: "Missing required fields: title, department, scheduled_at, meeting_type",
      });
    }

    // RBAC ship rule:
    // If Subadmin (3) or Crew (4), force ship_id to their ship (prevents cross-ship creation).
    let finalShipId = ship_id;
    if (role_id === 3 || role_id === 4) {
      finalShipId = userShipId ?? null;
    }

    // ---------------------------
    // Provider (Google Meet) block
    // ---------------------------
    let provider_platform = "manual";
    let provider_meeting_id = null;
    let provider_join_url = meeting_link;
    let provider_calendar_event_id = null;
    let provider_payload = null;

    let effectiveCompanyId = company_id;

    if (role_id === 1 && req.body?.company_id) {
      effectiveCompanyId = String(req.body.company_id);
    }

    if (!effectiveCompanyId) {
      return res.status(400).json({ error: "company_id is required for superadmin" });
    }

    if (platform === "google") {
      // This will throw if Google is not connected (oauth_connections missing)
      const created = await createGoogleMeetEvent(company_id, {
        title,
        description,
        scheduled_at,
        duration_minutes,
        attendees: send_invitations ? attendees : [], // only invite if checkbox true
      });

      provider_platform = "google";
      provider_calendar_event_id = created.calendar_event_id;
      provider_join_url = created.join_url; // https://meet.google.com/...
      provider_payload = created.raw; // store raw event response
    }

    if (platform === "zoom") {
      // This will throw if Zoom is not connected
      const created = await createZoomMeeting(company_id, {
        title,
        description,
        scheduled_at,
        duration_minutes,
      });

      provider_platform = "zoom";
      provider_meeting_id = created.meeting_id; // zoom meeting id
      provider_join_url = created.join_url;     // join link for attendees
      provider_payload = created.raw;           // full payload (includes start_url)
    }

    if (platform === "teams") {
      const created = await createTeamsMeeting(company_id, {
        title,
        description,
        scheduled_at,
        duration_minutes,
      });

      provider_platform = "teams";
      provider_meeting_id = created.meeting_id;
      provider_join_url = created.join_url;
      provider_payload = created.raw;
    }
    // Insert meeting (includes provider fields)
    const insertMeetingSql = `
      INSERT INTO training_meetings (
        company_id, ship_id, created_by,
        title, description, department, course_title,
        scheduled_at, duration_minutes, priority, meeting_type,
        meeting_link, send_invitations,
        provider_platform, provider_meeting_id, provider_join_url,
        provider_calendar_event_id, provider_payload
      )
      VALUES (
        $1, $2, $3,
        $4, $5, $6, $7,
        $8, $9, $10, $11,
        $12, $13,
        $14, $15, $16,
        $17, $18
      )
      RETURNING *;
    `;

    const meetingResult = await db.query(insertMeetingSql, [
      company_id,
      finalShipId,
      user_id,
      title,
      description,
      department,
      course_title,
      scheduled_at,
      duration_minutes,
      priority,
      meeting_type,
      provider_join_url || meeting_link, // meeting_link becomes the join url for google
      !!send_invitations,
      provider_platform,
      provider_meeting_id,
      provider_join_url,
      provider_calendar_event_id,
      provider_payload,
    ]);

    const meeting = meetingResult.rows[0];

    // Insert attendees (optional)
    // We store emails and keep user_id nullable for now.
    if (Array.isArray(attendees) && attendees.length > 0) {
      const values = [];
      const params = [];
      let p = 1;

      for (const email of attendees) {
        if (!email) continue;
        params.push(meeting.meeting_id, String(email).trim());
        values.push(`($${p++}, $${p++})`);
      }

      if (values.length > 0) {
        const insertAttSql = `
          INSERT INTO training_meeting_attendees (meeting_id, email)
          VALUES ${values.join(",")}
          ON CONFLICT DO NOTHING;
        `;
        await db.query(insertAttSql, params);
      }
    }

    return res.status(201).json({ meeting_id: meeting.meeting_id, meeting });
  } catch (err) {
    console.error("createMeeting error:", err);
    return res.status(500).json({
      error: "Failed to create meeting",
      detail: err?.message || String(err),
    });
  }
}

/**
 * POST /meetings/query
 * Listing via POST with filters (as you requested).
 * Body:
 * {
 *   page, limit,
 *   search,        // searches title (ILIKE)
 *   department,
 *   priority,
 *   meeting_type
 * }
 */
export async function queryMeetings(req, res) {
  try {
    const { role_id, company_id, ship_id } = getUserScope(req);
    const { sql: scopeSql, params: scopeParams } = buildScopeWhere({ role_id, company_id, ship_id });

    const {
      page = 1,
      limit = 50,
      search = null,
      department = null,
      priority = null,
      meeting_type = null,
      include_deleted = false,
    } = req.body || {};

    const safePage = Math.max(1, parseInt(page, 10) || 1);
    const safeLimit = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));
    const offset = (safePage - 1) * safeLimit;

    // Dynamic WHERE building with parameter indexing
    const whereParts = [`(${scopeSql})`];
    const params = [...scopeParams];
    let idx = params.length + 1;

    if (!include_deleted) whereParts.push(`m.deleted_at IS NULL`);

    if (search) {
      params.push(`%${String(search).trim()}%`);
      whereParts.push(`m.title ILIKE $${idx++}`);
    }

    if (department) {
      params.push(String(department).trim());
      whereParts.push(`m.department = $${idx++}`);
    }

    if (priority) {
      params.push(String(priority).trim());
      whereParts.push(`m.priority = $${idx++}::meeting_priority_enum`);
    }

    if (meeting_type) {
      params.push(String(meeting_type).trim());
      whereParts.push(`m.meeting_type = $${idx++}::meeting_type_enum`);
    }

    // Pagination params
    params.push(safeLimit);
    const limitIdx = idx++;
    params.push(offset);
    const offsetIdx = idx++;

    const listSql = `
      SELECT m.*
      FROM training_meetings m
      WHERE ${whereParts.join(" AND ")}
      ORDER BY m.scheduled_at DESC
      LIMIT $${limitIdx} OFFSET $${offsetIdx};
    `;

    const countSql = `
      SELECT COUNT(*)::int AS total
      FROM training_meetings m
      WHERE ${whereParts.join(" AND ")};
    `;

    const [listResult, countResult] = await Promise.all([
      db.query(listSql, params),
      db.query(countSql, params.slice(0, params.length - 2)), // count doesn't need limit/offset
    ]);

    return res.json({
      page: safePage,
      limit: safeLimit,
      total: countResult.rows[0]?.total ?? 0,
      items: listResult.rows,
    });
  } catch (err) {
    console.error("queryMeetings error:", err);
    return res.status(500).json({ error: "Failed to query meetings" });
  }
}

/**
 * GET /meetings/:meeting_id
 * Returns meeting + attendees
 */
export async function getMeetingById(req, res) {
  try {
    const meetingId = parseInt(req.params.meeting_id, 10);
    if (!Number.isFinite(meetingId)) {
      return res.status(400).json({ error: "Invalid meeting_id" });
    }

    const { role_id, company_id, ship_id } = getUserScope(req);
    const { sql: scopeSql, params: scopeParams } = buildScopeWhere({ role_id, company_id, ship_id });

    const meetingSql = `
      SELECT m.*
      FROM training_meetings m
      WHERE m.meeting_id = $1
        AND (${scopeSql})
        AND m.deleted_at IS NULL
      LIMIT 1;
    `;

    const meetingResult = await db.query(meetingSql, [meetingId, ...scopeParams]);
    const meeting = meetingResult.rows[0];

    if (!meeting) return res.status(404).json({ error: "Meeting not found" });

    const attendeesSql = `
      SELECT attendee_id, meeting_id, user_id, email, invite_status, invited_at
      FROM training_meeting_attendees
      WHERE meeting_id = $1
      ORDER BY attendee_id ASC;
    `;
    const attendeesResult = await db.query(attendeesSql, [meetingId]);

    return res.json({ meeting, attendees: attendeesResult.rows });
  } catch (err) {
    console.error("getMeetingById error:", err);
    return res.status(500).json({ error: "Failed to fetch meeting" });
  }
}

/**
 * PATCH /meetings/:meeting_id
 * Update allowed fields only (meeting_id cannot change).
 * NOTE: This currently updates ONLY DB, not Google Calendar event.
 * We can add provider-sync later.
 */
export async function updateMeeting(req, res) {
  try {
    const meetingId = parseInt(req.params.meeting_id, 10);
    if (!Number.isFinite(meetingId)) {
      return res.status(400).json({ error: "Invalid meeting_id" });
    }

    const { role_id, company_id, ship_id, ship_id: userShipId } = getUserScope(req);
    const { sql: scopeSql, params: scopeParams } = buildScopeWhere({ role_id, company_id, ship_id });

    const {
      title,
      description,
      department,
      course_title,
      scheduled_at,
      duration_minutes,
      priority,
      meeting_type,
      meeting_link,
      send_invitations,
      ship_id: bodyShipId,
      status,
    } = req.body || {};

    // Subadmin/Crew cannot change ship_id across ships
    let finalShipId = bodyShipId;
    if (role_id === 3 || role_id === 4) {
      finalShipId = userShipId ?? null;
    }

    // Build dynamic UPDATE
    const sets = [];
    const params = [meetingId, ...scopeParams];
    let idx = params.length + 1;

    const addSet = (col, val, cast = "") => {
      if (val === undefined) return;
      params.push(val);
      sets.push(`${col} = $${idx++}${cast}`);
    };

    addSet("title", title);
    addSet("description", description);
    addSet("department", department);
    addSet("course_title", course_title);
    addSet("scheduled_at", scheduled_at);
    addSet("duration_minutes", duration_minutes);
    addSet("priority", priority, "::meeting_priority_enum");
    addSet("meeting_type", meeting_type, "::meeting_type_enum");
    addSet("meeting_link", meeting_link);
    addSet("send_invitations", send_invitations);
    addSet("ship_id", finalShipId);
    addSet("status", status);

    if (sets.length === 0) {
      return res.status(400).json({ error: "No fields provided to update" });
    }

    const updateSql = `
      UPDATE training_meetings m
      SET ${sets.join(", ")},
          updated_at = NOW()
      WHERE m.meeting_id = $1
        AND (${scopeSql})
        AND m.deleted_at IS NULL
      RETURNING *;
    `;

    const result = await db.query(updateSql, params);
    if (result.rowCount === 0) return res.status(404).json({ error: "Meeting not found" });

    return res.json({ meeting: result.rows[0] });
  } catch (err) {
    console.error("updateMeeting error:", err);
    return res.status(500).json({ error: "Failed to update meeting" });
  }
}

/**
 * DELETE /meetings/:meeting_id
 * Soft delete (sets deleted_at)
 * NOTE: This currently deletes ONLY DB, not Google Calendar event.
 * We can add provider-sync later.
 */
export async function deleteMeeting(req, res) {
  try {
    const meetingId = parseInt(req.params.meeting_id, 10);
    if (!Number.isFinite(meetingId)) {
      return res.status(400).json({ error: "Invalid meeting_id" });
    }

    const { role_id, company_id, ship_id } = getUserScope(req);
    const { sql: scopeSql, params: scopeParams } = buildScopeWhere({ role_id, company_id, ship_id });

    const delSql = `
      UPDATE training_meetings m
      SET deleted_at = NOW(),
          updated_at = NOW()
      WHERE m.meeting_id = $1
        AND (${scopeSql})
        AND m.deleted_at IS NULL
      RETURNING meeting_id;
    `;

    const result = await db.query(delSql, [meetingId, ...scopeParams]);
    if (result.rowCount === 0) return res.status(404).json({ error: "Meeting not found" });

    return res.json({ success: true, meeting_id: result.rows[0].meeting_id });
  } catch (err) {
    console.error("deleteMeeting error:", err);
    return res.status(500).json({ error: "Failed to delete meeting" });
  }
}

/**
 * POST /meetings/:meeting_id/send-emails
 * FE sends list of emails (and optionally custom message).
 * Body: { emails: [...], subject?, message? }
 *
 * NOTE:
 * - You already have mail routes (mailTestRoutes, userMailRoutes).
 * - Here we only build the endpoint & payload.
 * - You must plug in your mail function (nodemailer, sendgrid, etc.)
 */
export async function sendMeetingEmails(req, res) {
  try {
    const meetingId = parseInt(req.params.meeting_id, 10);
    if (!Number.isFinite(meetingId)) {
      return res.status(400).json({ error: "Invalid meeting_id" });
    }

    const { role_id, company_id, ship_id } = getUserScope(req);
    const { sql: scopeSql, params: scopeParams } = buildScopeWhere({ role_id, company_id, ship_id });

    const { emails = [], subject, message } = req.body || {};
    if (!Array.isArray(emails) || emails.length === 0) {
      return res.status(400).json({ error: "emails[] is required" });
    }

    // Fetch meeting to include details
    const meetingSql = `
      SELECT m.*
      FROM training_meetings m
      WHERE m.meeting_id = $1
        AND (${scopeSql})
        AND m.deleted_at IS NULL
      LIMIT 1;
    `;
    const meetingResult = await db.query(meetingSql, [meetingId, ...scopeParams]);
    const meeting = meetingResult.rows[0];
    if (!meeting) return res.status(404).json({ error: "Meeting not found" });

    // Build email content (basic)
    const finalSubject = subject || `Meeting Invitation: ${meeting.title} (${meeting.meeting_type})`;

    const bodyText = `
Meeting: ${meeting.title}
Type: ${meeting.meeting_type}
Department: ${meeting.department}
Priority: ${meeting.priority}
Scheduled At: ${meeting.scheduled_at}
Link: ${meeting.meeting_link || "N/A"}

${message ? "\nMessage:\n" + message : ""}
`.trim();

    // TODO: integrate your actual mail sender here
    const sentTo = emails.map((e) => String(e).trim()).filter(Boolean);

    return res.json({
      success: true,
      meeting_id: meetingId,
      subject: finalSubject,
      preview: bodyText,
      sent_to: sentTo,
      note: "Hook your real mail sender in meetingController.sendMeetingEmails()",
    });
  } catch (err) {
    console.error("sendMeetingEmails error:", err);
    return res.status(500).json({ error: "Failed to send meeting emails" });
  }
}