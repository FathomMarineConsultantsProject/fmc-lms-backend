
import { db } from "../db.js";

const toDateOrNull = (value) => {
  if (value === null || value === undefined || String(value).trim() === "") {
    return null;
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime())
      ? null
      : value.toISOString().slice(0, 10);
  }

  const str = String(value).trim();

  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
    return str;
  }

  const date = new Date(str);

  return Number.isNaN(date.getTime())
    ? null
    : date.toISOString().slice(0, 10);
};

export const handleShipHistoryChange = async ({
  client = db,
  user_id,
  company_id,
  old_company_id,
  old_ship_id,
  new_ship_id,
  previous_embarkation_date,
  new_embarkation_date,
  change_date,
  embarkation_port,
  disembarkation_port,
  changed_by_user_id,
  notes = null,
}) => {
  if (!user_id) return;

  const oldShip = old_ship_id == null ? null : Number(old_ship_id);
  const newShip = new_ship_id == null ? null : Number(new_ship_id);

  const oldEmbDate = toDateOrNull(previous_embarkation_date);
  const newEmbDate = toDateOrNull(new_embarkation_date);
  const changeDate = toDateOrNull(change_date);

  // Do not modify history when the ship has not changed
  if (oldShip != null && newShip != null && oldShip === newShip) {
    return;
  }

  if (newShip != null && !newEmbDate) {
    throw new Error("New ship embarkation date is required");
  }

  // 1. Handle the previous ship
  if (oldShip != null) {
    if (!changeDate) {
      throw new Error("Ship change date is required");
    }

    const oldHistoryRes = await client.query(
      `SELECT history_id
       FROM user_ship_history
       WHERE user_id = $1
         AND ship_id = $2
         AND disembarkation_date IS NULL
       ORDER BY history_id DESC
       LIMIT 1
       FOR UPDATE`,
      [user_id, oldShip]
    );

    if (oldHistoryRes.rows.length > 0) {
      // Existing old history:
      // Update ONLY disembarkation date.
      await client.query(
        `UPDATE user_ship_history
         SET
           disembarkation_date = $1::date,
           disembarkation_port = COALESCE($2, disembarkation_port),
           changed_by_user_id = COALESCE($3, changed_by_user_id),
           notes = COALESCE($4, notes),
           updated_at = NOW()
         WHERE history_id = $5`,
        [
          changeDate,
          disembarkation_port ?? null,
          changed_by_user_id ?? null,
          notes,
          oldHistoryRes.rows[0].history_id,
        ]
      );
    } else {
      // Missing old history:
      // Create it using the ORIGINAL user embarkation date.
      await client.query(
        `INSERT INTO user_ship_history (
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
        VALUES ($1, $2, $3, $4::date, $5::date, $6, $7, $8, $9, NOW(), NOW())`,
        [
          user_id,
          old_company_id ?? company_id ?? null,
          oldShip,
          oldEmbDate,
          changeDate,
          null,
          disembarkation_port ?? null,
          changed_by_user_id ?? null,
          notes,
        ]
      );
    }
  }

  // 2. Insert the new ship history as an open record
  if (newShip != null) {
    await client.query(
      `INSERT INTO user_ship_history (
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
      VALUES ($1, $2, $3, $4::date, NULL, $5, NULL, $6, $7, NOW(), NOW())`,
      [
        user_id,
        company_id ?? null,
        newShip,
        newEmbDate,
        embarkation_port ?? null,
        changed_by_user_id ?? null,
        notes,
      ]
    );
  }
};
