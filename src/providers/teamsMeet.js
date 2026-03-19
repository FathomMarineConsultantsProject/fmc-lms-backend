import { getTeamsAccessToken } from "../controller/integrationController.js";

export async function createTeamsMeeting(
  company_id,
  { title, description, scheduled_at, duration_minutes, attendees = [] }
) {
  const token = await getTeamsAccessToken(company_id);

  const start = new Date(scheduled_at);
  const end = new Date(start.getTime() + Number(duration_minutes || 60) * 60_000);

  const eventBody = {
    subject: title,
    body: {
      contentType: "HTML",
      content: description || "",
    },
    start: {
      dateTime: start.toISOString().slice(0, 19),
      timeZone: "UTC",
    },
    end: {
      dateTime: end.toISOString().slice(0, 19),
      timeZone: "UTC",
    },
    isOnlineMeeting: true,
    onlineMeetingProvider: "teamsForBusiness",
    attendees: (attendees || []).map((email) => ({
      emailAddress: {
        address: String(email).trim().toLowerCase(),
      },
      type: "required",
    })),
  };

  const res = await fetch("https://graph.microsoft.com/v1.0/me/events", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(eventBody),
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.error?.message || "Teams meeting create failed");
  }

  return {
    meeting_id: data.id,
    calendar_event_id: data.id,
    join_url: data.onlineMeeting?.joinUrl || data.webLink || null,
    raw: data,
  };
}