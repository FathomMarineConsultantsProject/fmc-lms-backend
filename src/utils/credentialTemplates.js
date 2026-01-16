const escapeHtml = (s) =>
  String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

const brand = {
  primary: "#0B2B45",   // deep marine
  secondary: "#0E4D7A", // ocean blue
  accent: "#18A4C6",    // teal accent
  bg: "#F3F8FB",
  text: "#0B1B2B",
  muted: "#5E7486",
};

const wrap = ({ title, contentHtml }) => {
  const logoUrl = process.env.MAIL_LOGO_URL || ""; // optional

  return `
  <div style="margin:0;padding:0;background:${brand.bg};font-family:Arial,sans-serif;color:${brand.text};">
    <div style="max-width:760px;margin:0 auto;padding:24px;">
      
      <div style="background:${brand.primary};border-radius:14px 14px 0 0;padding:18px 20px;display:flex;align-items:center;gap:12px;">
        ${
          logoUrl
            ? `<img src="${escapeHtml(logoUrl)}" alt="Fathom Marine" style="height:34px;display:block;border-radius:6px;" />`
            : `<div style="width:34px;height:34px;border-radius:8px;background:${brand.accent};display:flex;align-items:center;justify-content:center;color:white;font-weight:700;">FM</div>`
        }
        <div style="color:white;">
          <div style="font-size:16px;font-weight:700;letter-spacing:0.3px;">Fathom Marine</div>
          <div style="font-size:12px;opacity:0.85;">Credential Delivery</div>
        </div>
      </div>

      <div style="background:white;border-radius:0 0 14px 14px;padding:22px 20px;box-shadow:0 8px 24px rgba(11,43,69,0.10);">
        <div style="font-size:18px;font-weight:700;margin:0 0 10px;">${escapeHtml(title)}</div>
        ${contentHtml}
        
        <div style="margin-top:18px;padding-top:14px;border-top:1px solid #E6EEF4;color:${brand.muted};font-size:12px;line-height:1.5;">
          <div><b>Confidential:</b> This email contains sensitive credentials. Do not forward.</div>
          <div>If you didn’t request this, contact your administrator immediately.</div>
        </div>

        <div style="margin-top:14px;color:${brand.muted};font-size:12px;">
          Regards,<br/>Fathom Marine
        </div>
      </div>

      <div style="text-align:center;color:${brand.muted};font-size:11px;margin-top:14px;">
        © ${new Date().getFullYear()} Fathom Marine
      </div>
    </div>
  </div>
  `;
};

const tableHtml = (rowsHtml) => `
  <div style="margin-top:10px;">
    <table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:separate;border-spacing:0;overflow:hidden;border-radius:12px;border:1px solid #E3ECF3;">
      <thead>
        <tr style="background:${brand.secondary};color:white;">
          <th style="text-align:left;padding:10px 12px;font-size:12px;">Employee No.</th>
          <th style="text-align:left;padding:10px 12px;font-size:12px;">Rank</th>
          <th style="text-align:left;padding:10px 12px;font-size:12px;">Name</th>
          <th style="text-align:left;padding:10px 12px;font-size:12px;">User ID</th>
          <th style="text-align:left;padding:10px 12px;font-size:12px;">Password</th>
        </tr>
      </thead>
      <tbody>
        ${rowsHtml}
      </tbody>
    </table>
  </div>
`;

const rowHtml = (r) => `
  <tr>
    <td style="padding:10px 12px;border-top:1px solid #E3ECF3;font-size:13px;">${escapeHtml(r.employee_no)}</td>
    <td style="padding:10px 12px;border-top:1px solid #E3ECF3;font-size:13px;">${escapeHtml(r.rank_name)}</td>
    <td style="padding:10px 12px;border-top:1px solid #E3ECF3;font-size:13px;">${escapeHtml(r.full_name)}</td>
    <td style="padding:10px 12px;border-top:1px solid #E3ECF3;font-size:13px;font-weight:700;color:${brand.primary};">${escapeHtml(r.username)}</td>
    <td style="padding:10px 12px;border-top:1px solid #E3ECF3;font-size:13px;font-weight:700;">${escapeHtml(r.plain_password)}</td>
  </tr>
`;

export const buildSingleCredentialEmail = ({ companyName, row }) => {
  const subject = `Fathom Marine | Login Credentials`;
  const contentHtml = `
    <p style="margin:0 0 10px;color:${brand.muted};">
      Hello,<br/>
      Your login credentials have been requested for <b>${escapeHtml(companyName || "Fathom Marine")}</b>.
    </p>
    ${tableHtml(rowHtml(row))}
  `;
  return { subject, html: wrap({ title: "Your Login Credentials", contentHtml }) };
};

export const buildBulkCredentialEmail = ({ companyName, rows }) => {
  const subject = `Fathom Marine | Crew Login Credentials (Bulk)`;

  const rowsHtml =
    rows?.length
      ? rows.map(rowHtml).join("")
      : `<tr><td colspan="5" style="padding:12px;color:${brand.muted};">No users found.</td></tr>`;

  const contentHtml = `
    <p style="margin:0 0 10px;color:${brand.muted};">
      Hello,<br/>
      Here is the list of requested user credentials for <b>${escapeHtml(companyName || "Fathom Marine")}</b>.
    </p>
    ${tableHtml(rowsHtml)}
  `;

  return { subject, html: wrap({ title: "Bulk Credential List", contentHtml }) };
};
