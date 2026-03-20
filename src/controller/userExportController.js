// src/controller/userExportController.js
import xlsx from "xlsx";
import { db } from "../db.js";

// Only these roles can export
const canExport = (roleId) => [1, 2, 3].includes(Number(roleId));

const safeDate = (v) => {
  if (!v) return "";
  try {
    // pg may return Date or string depending on config
    const d = v instanceof Date ? v : new Date(v);
    if (Number.isNaN(d.getTime())) return String(v);
    return d.toISOString().slice(0, 10);
  } catch {
    return String(v);
  }
};

const toExportRows = (rows) =>
  rows.map((u) => ({
    "User ID": u.user_id,
    "Seafarer ID": u.seafarer_id ?? "",
    Name: u.full_name ?? "",
    Rank: u.rank ?? "",
    Trip: u.trip ?? "",
    Status: u.status ?? "", // ✅ onboard/offboard included
    Username: u.username ?? "",
    "Company ID": u.company_id ?? "",
    "Ship ID": u.ship_id ?? "",
    "Embarkation Port": u.embarkation_port ?? "",
    "Embarkation Date": safeDate(u.embarkation_date),
    "Disembarkation Port": u.disembarkation_port ?? "",
    "Disembarkation Date": safeDate(u.disembarkation_date),
    "End of Contract": safeDate(u.end_of_contract),
    "Plus Months": u.plus_months ?? "",
    Nationality: u.nationality ?? "",
    Sex: u.sex ?? "",
    "Date of Birth": safeDate(u.date_of_birth),
    "Place of Birth": u.place_of_birth ?? "",
    "Passport Number": u.passport_number ?? "",
    "Passport Issue Place": u.passport_issue_place ?? "",
    "Passport Issue Date": safeDate(u.passport_issue_date),
    "Passport Expiry Date": safeDate(u.passport_expiry_date),
    "Seaman Book Number": u.seaman_book_number ?? "",
    "Seaman Book Issue Date": safeDate(u.seaman_book_issue_date),
    "Seaman Book Expiry Date": safeDate(u.seaman_book_expiry_date),
    "Role ID": u.role_id ?? "",
    "Created At": u.created_at ? String(u.created_at) : "",
    "Updated At": u.updated_at ? String(u.updated_at) : "",
  }));

export const exportSelectedCrewExcel = async (req, res) => {
  try {
    const role = Number(req.user?.role_id);
    if (!canExport(role)) return res.status(403).json({ error: "Forbidden" });

    const idsRaw = Array.isArray(req.body?.user_ids) ? req.body.user_ids : [];
    const ids = idsRaw
      .map((x) => Number.parseInt(String(x), 10))
      .filter((n) => Number.isInteger(n) && n > 0);

    if (!ids.length) {
      return res.status(400).json({ error: "user_ids must be a non-empty array of integers" });
    }

    const myCompany = req.user?.company_id ? String(req.user.company_id) : null;
    const myShip = req.user?.ship_id != null ? Number(req.user.ship_id) : null;

    // Pull only the IDs requested
    const { rows } = await db.query(
      `
      SELECT
        u.user_id,
        u.seafarer_id,
        u.full_name,
        u.rank,
        u.trip,
        u.status,
        u.username,
        u.company_id,
        u.ship_id,
        u.embarkation_port,
        u.embarkation_date,
        u.disembarkation_port,
        u.disembarkation_date,
        u.end_of_contract,
        u.plus_months,
        u.nationality,
        u.sex,
        u.date_of_birth,
        u.place_of_birth,
        u.passport_number,
        u.passport_issue_place,
        u.passport_issue_date,
        u.passport_expiry_date,
        u.seaman_book_number,
        u.seaman_book_issue_date,
        u.seaman_book_expiry_date,
        u.created_at,
        u.updated_at,
        u.role_id
      FROM users u
      WHERE u.user_id = ANY($1::int[])
      ORDER BY u.user_id ASC
      `,
      [ids]
    );

    if (!rows.length) {
      return res.status(404).json({ error: "No users found for given user_ids" });
    }

    // ✅ Scope enforcement: role 2 only own company, role 3 only own company+ship
    const allowed = rows.filter((u) => {
      if (role === 1) return true;

      const uCompany = u.company_id ? String(u.company_id) : null;
      const uShip = u.ship_id != null ? Number(u.ship_id) : null;

      if (role === 2) return myCompany && uCompany && myCompany === uCompany;
      if (role === 3) return myCompany && uCompany && myCompany === uCompany && myShip != null && uShip != null && myShip === uShip;

      return false;
    });

    const skipped = ids.length - allowed.length;

    if (!allowed.length) {
      return res.status(403).json({ error: "All selected users are out of your scope" });
    }

    const wb = xlsx.utils.book_new();
    const ws = xlsx.utils.json_to_sheet(toExportRows(allowed));
    xlsx.utils.book_append_sheet(wb, ws, "Crew");

    const buf = xlsx.write(wb, { type: "buffer", bookType: "xlsx" });

    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    const filename = `crew_selected_${stamp}.xlsx`;

    // Optional metadata header so frontend can show “skipped N out-of-scope”
    res.setHeader("X-Export-Skipped", String(skipped));

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    return res.status(200).send(buf);
  } catch (err) {
    console.error("exportSelectedCrewExcel error:", err);
    return res.status(500).json({ error: "Failed to export selected crew excel" });
  }
};

export const exportCrewExcel = async (req, res) => {
  try {
    const role = Number(req.user?.role_id);
    if (!canExport(role)) return res.status(403).json({ error: "Forbidden" });

    const myCompany = req.user?.company_id ? String(req.user.company_id) : null;
    const myShip = req.user?.ship_id != null ? Number(req.user.ship_id) : null;

    // Optional filters for role 1/2
    const qCompany = req.query?.company_id ? String(req.query.company_id) : null;
    const qShip = req.query?.ship_id != null ? Number(req.query.ship_id) : null;
    const qStatus = req.query?.status ? String(req.query.status).trim() : null; // "Onboard"/"Offboard"

    // Build SQL + params with scope enforcement
    let where = [];
    let params = [];

    // ROLE SCOPE
    if (role === 1) {
      // superadmin: optional filters
      if (qCompany) {
        params.push(qCompany);
        where.push(`u.company_id = $${params.length}`);
      }
      if (Number.isFinite(qShip)) {
        params.push(qShip);
        where.push(`u.ship_id = $${params.length}`);
      }
    } else if (role === 2) {
      // company admin: force company scope
      if (!myCompany) return res.status(400).json({ error: "Admin has no company_id" });

      params.push(myCompany);
      where.push(`u.company_id = $${params.length}`);

      // optional ship filter but still within company
      if (Number.isFinite(qShip)) {
        params.push(qShip);
        where.push(`u.ship_id = $${params.length}`);
      }
    } else if (role === 3) {
      // subadmin: force company + ship scope
      if (!myCompany || myShip == null) {
        return res.status(400).json({ error: "Subadmin missing company_id or ship_id" });
      }

      params.push(myCompany);
      where.push(`u.company_id = $${params.length}`);

      params.push(myShip);
      where.push(`u.ship_id = $${params.length}`);
    }

    // Optional status filter (all roles)
    if (qStatus) {
      params.push(qStatus);
      where.push(`LOWER(COALESCE(u.status,'')) = LOWER($${params.length})`);
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    // IMPORTANT: exclude password_hash/password_enc/reset tokens etc in export
    const sql = `
      SELECT
        u.user_id,
        u.seafarer_id,
        u.full_name,
        u.rank,
        u.trip,
        u.status,
        u.username,
        u.company_id,
        u.ship_id,
        u.embarkation_port,
        u.embarkation_date,
        u.disembarkation_port,
        u.disembarkation_date,
        u.end_of_contract,
        u.plus_months,
        u.nationality,
        u.sex,
        u.date_of_birth,
        u.place_of_birth,
        u.passport_number,
        u.passport_issue_place,
        u.passport_issue_date,
        u.passport_expiry_date,
        u.seaman_book_number,
        u.seaman_book_issue_date,
        u.seaman_book_expiry_date,
        u.created_at,
        u.updated_at,
        u.role_id
      FROM users u
      ${whereSql}
      ORDER BY u.company_id NULLS LAST, u.ship_id NULLS LAST, u.user_id ASC
    `;

    const { rows } = await db.query(sql, params);

    // Convert to export-friendly rows (nice column titles)
    const data = rows.map((u) => ({
      "User ID": u.user_id,
      "Seafarer ID": u.seafarer_id ?? "",
      Name: u.full_name ?? "",
      Rank: u.rank ?? "",
      Trip: u.trip ?? "",
      Status: u.status ?? "",
      Username: u.username ?? "",
      "Company ID": u.company_id ?? "",
      "Ship ID": u.ship_id ?? "",
      "Embarkation Port": u.embarkation_port ?? "",
      "Embarkation Date": safeDate(u.embarkation_date),
      "Disembarkation Port": u.disembarkation_port ?? "",
      "Disembarkation Date": safeDate(u.disembarkation_date),
      "End of Contract": safeDate(u.end_of_contract),
      "Plus Months": u.plus_months ?? "",
      Nationality: u.nationality ?? "",
      Sex: u.sex ?? "",
      "Date of Birth": safeDate(u.date_of_birth),
      "Place of Birth": u.place_of_birth ?? "",
      "Passport Number": u.passport_number ?? "",
      "Passport Issue Place": u.passport_issue_place ?? "",
      "Passport Issue Date": safeDate(u.passport_issue_date),
      "Passport Expiry Date": safeDate(u.passport_expiry_date),
      "Seaman Book Number": u.seaman_book_number ?? "",
      "Seaman Book Issue Date": safeDate(u.seaman_book_issue_date),
      "Seaman Book Expiry Date": safeDate(u.seaman_book_expiry_date),
      "Role ID": u.role_id ?? "",
      "Created At": u.created_at ? String(u.created_at) : "",
      "Updated At": u.updated_at ? String(u.updated_at) : "",
    }));

    const wb = xlsx.utils.book_new();
    const ws = xlsx.utils.json_to_sheet(data);
    xlsx.utils.book_append_sheet(wb, ws, "Crew");

    const buf = xlsx.write(wb, { type: "buffer", bookType: "xlsx" });

    // Filename based on scope
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    const filename = `crew_export_${stamp}.xlsx`;

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    return res.status(200).send(buf);
  } catch (err) {
    console.error("exportCrewExcel error:", err);
    return res.status(500).json({ error: "Failed to export crew excel" });
  }
};


