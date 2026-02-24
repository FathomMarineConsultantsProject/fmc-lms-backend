import { google } from "googleapis";
import { getGoogleAccessToken } from "../controller/integrationController.js";

/**
 * Creates a Google Calendar event + Google Meet link.
 * Returns event id + join link.
 */
export async function createGoogleMeetEvent(company_id, payload) {
  const accessToken = await getGoogleAccessToken(company_id);

  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: accessToken });

  const calendar = google.calendar({ version: "v3", auth });

  const start = new Date(payload.scheduled_at);
  const end = new Date(start.getTime() + (payload.duration_minutes || 60) * 60000);

  const eventRes = await calendar.events.insert({
    calendarId: "primary",
    conferenceDataVersion: 1,
    requestBody: {
      summary: payload.title,
      description: payload.description || "",
      start: { dateTime: start.toISOString() },
      end: { dateTime: end.toISOString() },
      attendees: (payload.attendees || []).map((email) => ({ email })),
      conferenceData: {
        createRequest: {
          requestId: "fmc-" + Date.now(), // unique
          conferenceSolutionKey: { type: "hangoutsMeet" },
        },
      },
    },
  });

  const e = eventRes.data;

  const joinUrl =
    e.hangoutLink ||
    e.conferenceData?.entryPoints?.find((x) => x.entryPointType === "video")?.uri ||
    null;

  return {
    calendar_event_id: e.id,
    join_url: joinUrl,
    raw: e,
  };
}