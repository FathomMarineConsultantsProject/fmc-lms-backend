// src/providers/zoomMeet.js
import { getZoomAccessToken } from "../controller/integrationController.js";

export async function createZoomMeeting(
  company_id,
  { title, description, scheduled_at, duration_minutes }
) {
  const token = await getZoomAccessToken(company_id);

  const body = {
    topic: title,
    type: 2,
    start_time: new Date(scheduled_at).toISOString(),
    duration: Number(duration_minutes || 60),
    agenda: description || "",
    settings: {
      join_before_host: true,
      waiting_room: false,
      meeting_authentication: false,
      approval_type: 2,
      registration_type: 1,
    },
  };

  const res = await fetch("https://api.zoom.us/v2/users/me/meetings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.message || "Zoom meeting create failed");
  }

  return {
    meeting_id: String(data.id),
    join_url: data.join_url,
    start_url: data.start_url,
    raw: data,
  };
}