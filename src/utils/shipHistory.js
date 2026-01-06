// src/utils/shipHistory.js
import { db } from "../db.js";

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
  // No change → do nothing
  if (Number(old_ship_id) === Number(new_ship_id)) return;

  // 1️⃣ Close previous active ship history
  if (old_ship_id) {
    await db.query(
      `
      UPDATE user_ship_history
      SET
        disembarkation_date = COALESCE($1, disembarkation_date),
        disembarkation_port = COALESCE($2, disembarkation_port),
        updated_at = NOW()
      WHERE user_id = $3
        AND ship_id = $4
        AND disembarkation_date IS NULL
      `,
      [
        disembarkation_date ?? new Date(),
        disembarkation_port ?? null,
        user_id,
        old_ship_id,
      ]
    );
  }

  // 2️⃣ Insert new ship history
  if (new_ship_id) {
    await db.query(
      `
      INSERT INTO user_ship_history
      (user_id, company_id, ship_id,
       embarkation_date, embarkation_port,
       changed_by_user_id, notes,
       created_at, updated_at)
      VALUES
      ($1,$2,$3,$4,$5,$6,$7,NOW(),NOW())
      `,
      [
        user_id,
        company_id,
        new_ship_id,
        embarkation_date ?? new Date(),
        embarkation_port ?? null,
        changed_by_user_id ?? null,
        notes,
      ]
    );
  }
};
