import { getTeamsAccessToken } from "../controller/integrationController.js";

export async function createTeamsMeeting(company_id, { title, description, scheduled_at, duration_minutes }) {
  const token = await getTeamsAccessToken(company_id);

  const start = new Date(scheduled_at);
  const end = new Date(start.getTime() + Number(duration_minutes || 60) * 60_000);

  const res = await fetch("https://graph.microsoft.com/v1.0/me/onlineMeetings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      subject: title,
      startDateTime: start.toISOString(),
      endDateTime: end.toISOString(),
      // optional:
      // participants: { ... }  (can add later)
    }),
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.error?.message || "Teams meeting create failed");
  }

  return {
    meeting_id: data.id,
    join_url: data.joinWebUrl,
    raw: data,
  };
}