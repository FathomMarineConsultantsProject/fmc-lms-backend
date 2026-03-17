// src/utils/shipHistory.js
import { db } from "../db.js";

const toDateOrNull = (v) => {
  if (v === null || v === undefined || String(v).trim?.() === "") return null;

  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return null;

  return d.toISOString().slice(0, 10);
};

export const handleShipHistoryChange = async ({
  user_id,
  company_id,
  old_ship_id,
  new_ship_id,
  embarkation_date,
  disembarkation_date,
  embarkation_port,
  disembarkation_port,
  changed_by_user_id,
  notes = null,
}) => {
  if (!user_id) return;

  const oldShip = old_ship_id == null ? null : Number(old_ship_id);
  const newShip = new_ship_id == null ? null : Number(new_ship_id);

  const embDate = toDateOrNull(embarkation_date);
  const disDate = toDateOrNull(disembarkation_date);

  // 1) Lock ALL open rows for this user
  const openRes = await db.query(
    `
    SELECT
      history_id,
      ship_id
    FROM user_ship_history
    WHERE user_id = $1
      AND disembarkation_date IS NULL
    ORDER BY history_id DESC
    FOR UPDATE
    `,
    [user_id]
  );

  const openRows = openRes.rows || [];

  // 2) SAME SHIP re-upload => update existing open row only, no insert
  if (oldShip != null && newShip != null && oldShip === newShip) {
    const sameOpen = openRows.find((r) => Number(r.ship_id) === newShip);

    if (sameOpen) {
      await db.query(
        `
        UPDATE user_ship_history
        SET
          embarkation_date = COALESCE($1::date, embarkation_date),
          embarkation_port = COALESCE($2, embarkation_port),
          disembarkation_date = COALESCE($3::date, disembarkation_date),
          disembarkation_port = COALESCE($4, disembarkation_port),
          changed_by_user_id = COALESCE($5, changed_by_user_id),
          notes = COALESCE($6, notes),
          updated_at = NOW()
        WHERE history_id = $7
        `,
        [
          embDate,
          embarkation_port ?? null,
          disDate,
          disembarkation_port ?? null,
          changed_by_user_id ?? null,
          notes ?? null,
          sameOpen.history_id,
        ]
      );
    }

    return;
  }

  // 3) Close ALL currently open rows first
  if (openRows.length) {
    const historyIds = openRows.map((r) => Number(r.history_id)).filter(Number.isInteger);

    if (historyIds.length) {
      await db.query(
        `
        UPDATE user_ship_history
        SET
          disembarkation_date = COALESCE($1::date, CURRENT_DATE),
          disembarkation_port = COALESCE($2, disembarkation_port),
          changed_by_user_id = COALESCE($3, changed_by_user_id),
          notes = COALESCE($4, notes),
          updated_at = NOW()
        WHERE history_id = ANY($5::int[])
        `,
        [
          disDate,
          disembarkation_port ?? null,
          changed_by_user_id ?? null,
          notes ?? null,
          historyIds,
        ]
      );
    }
  }

  // 4) If user now has a new ship, insert one new open row
  if (newShip != null) {
    await db.query(
      `
      INSERT INTO user_ship_history
      (
        user_id,
        company_id,
        ship_id,
        embarkation_date,
        disembarkation_date,
        embarkation_port,
        disembarkation_port,
        changed_by_user_id,
        notes,
        created_at,
        updated_at
      )
      VALUES
      (
        $1, $2, $3, $4::date, $5::date, $6, $7, $8, $9, NOW(), NOW()
      )
      `,
      [
        user_id,
        company_id ?? null,
        newShip,
        embDate,
        null, // IMPORTANT: new open row should stay open
        embarkation_port ?? null,
        null,
        changed_by_user_id ?? null,
        notes ?? null,
      ]
    );
  }
};