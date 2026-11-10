
import { db } from "../db.js";

const toDateOrNull = (value) => {
  if (
    value === null ||
    value === undefined ||
    String(value).trim() === ""
  ) {
    return null;
  }

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;

    return value.toISOString().slice(0, 10);
  }

  const str = String(value).trim();

  // Preserve an existing YYYY-MM-DD date without timezone conversion
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
    return str;
  }

  const date = new Date(str);

  if (Number.isNaN(date.getTime())) return null;

  return date.toISOString().slice(0, 10);
};

export const handleShipHistoryChange = async ({
  client = db,
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

  const oldShip =
    old_ship_id == null ? null : Number(old_ship_id);

  const newShip =
    new_ship_id == null ? null : Number(new_ship_id);

  const embDate = toDateOrNull(embarkation_date);
  const disDate = toDateOrNull(disembarkation_date);

  // Same ship: do not modify ship history
  if (oldShip != null && newShip != null && oldShip === newShip) {
    return;
  }

  // 1. Close only the latest open history record
  // belonging to the previous ship
  if (oldShip != null) {
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

    if (oldHistoryRes.rows.length) {
      const oldHistoryId = oldHistoryRes.rows[0].history_id;

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
          disDate,
          disembarkation_port ?? null,
          changed_by_user_id ?? null,
          notes ?? null,
          oldHistoryId,
        ]
      );
    }
  }

  // 2. Create a new open history record for the new ship
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
      VALUES (
        $1, $2, $3, $4::date, NULL, $5, NULL, $6, $7, NOW(), NOW()
      )`,
      [
        user_id,
        company_id ?? null,
        newShip,
        embDate,
        embarkation_port ?? null,
        changed_by_user_id ?? null,
        notes ?? null,
      ]
    );
  }
};
