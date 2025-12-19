// src/controller/assessmentsController.js
import { db } from '../db.js';

const ROLE_SUPERADMIN = 1;
const ROLE_ADMIN = 2;
const ROLE_SUBADMIN = 3;
const ROLE_CREW = 4;

/**
 * Builds scope WHERE + params for assessments based on role.
 * IMPORTANT: supports startIndex so it can be safely combined with other $ placeholders
 * (example: when you already use $1 for assessment_id, use startIndex=2).
 */
const assessScope = (req, alias = 'a', startIndex = 1) => {
  const a = alias ? `${alias}.` : '';
  const role = Number(req.user?.role_id);

  const p1 = `$${startIndex}`;
  const p2 = `$${startIndex + 1}`;

  if (role === ROLE_SUPERADMIN) return { where: 'TRUE', params: [] };

  if (role === ROLE_ADMIN) {
    return { where: `${a}company_id = ${p1}`, params: [req.user.company_id] };
  }

  if (role === ROLE_SUBADMIN) {
    return {
      where: `${a}company_id = ${p1} AND ${a}ship_id = ${p2}`,
      params: [req.user.company_id, req.user.ship_id],
    };
  }

  // ROLE_CREW: only published for their company, and ship either NULL or matches their ship
  return {
    where: `${a}status = 'published' AND ${a}company_id = ${p1} AND (${a}ship_id IS NULL OR ${a}ship_id = ${p2})`,
    params: [req.user.company_id, req.user.ship_id],
  };
};

const canWrite = (roleId) => [ROLE_SUPERADMIN, ROLE_ADMIN, ROLE_SUBADMIN].includes(Number(roleId));

// helper: build nested object from join rows
const shapeAssessmentRows = (rows) => {
  const map = new Map();

  for (const r of rows) {
    if (!map.has(r.assessment_id)) {
      map.set(r.assessment_id, {
        assessment_id: r.assessment_id,
        company_id: r.company_id,
        ship_id: r.ship_id,
        created_by_user_id: r.created_by_user_id,
        title: r.title,
        description: r.description,
        status: r.status,
        metadata_json: r.metadata_json,
        created_at: r.created_at,
        updated_at: r.updated_at,
        questions: [],
      });
    }

    const a = map.get(r.assessment_id);

    if (r.question_id) {
      let q = a.questions.find((x) => x.question_id === r.question_id);
      if (!q) {
        q = {
          question_id: r.question_id,
          question_order: r.question_order,
          question_type: r.question_type,
          question_text: r.question_text,
          points: r.points,
          correct_answer_text: r.correct_answer_text,
          explanation: r.explanation,
          metadata_json: r.q_metadata_json,
          created_at: r.q_created_at,
          updated_at: r.q_updated_at,
          options: [],
        };
        a.questions.push(q);
      }

      if (r.option_id) {
        q.options.push({
          option_id: r.option_id,
          option_order: r.option_order,
          option_text: r.option_text,
          is_correct: r.is_correct,
          created_at: r.o_created_at,
          updated_at: r.o_updated_at,
        });
      }
    }
  }

  // ensure ordering
  for (const a of map.values()) {
    a.questions.sort((x, y) => (x.question_order ?? 0) - (y.question_order ?? 0));
    for (const q of a.questions) {
      q.options.sort((x, y) => (x.option_order ?? 0) - (y.option_order ?? 0));
    }
  }

  return Array.from(map.values());
};

// GET /assessments
export const getAllAssessments = async (req, res) => {
  try {
    const { where, params } = assessScope(req, 'a', 1);

    const { rows } = await db.query(
      `
      SELECT
        a.*,

        q.question_id,
        q.question_order,
        q.question_type,
        q.question_text,
        q.points,
        q.correct_answer_text,
        q.explanation,
        q.metadata_json  AS q_metadata_json,
        q.created_at     AS q_created_at,
        q.updated_at     AS q_updated_at,

        o.option_id,
        o.option_order,
        o.option_text,
        o.is_correct,
        o.created_at     AS o_created_at,
        o.updated_at     AS o_updated_at

      FROM assessments a
      LEFT JOIN assessment_questions q ON q.assessment_id = a.assessment_id
      LEFT JOIN assessment_options o ON o.question_id = q.question_id
      WHERE ${where}
      ORDER BY a.created_at DESC, q.question_order ASC NULLS LAST, o.option_order ASC NULLS LAST
      `,
      params
    );

    return res.json(shapeAssessmentRows(rows));
  } catch (err) {
    console.error('Error getting assessments:', err);
    return res.status(500).json({ error: 'Failed to fetch assessments' });
  }
};

// GET /assessments/:id
export const getAssessmentById = async (req, res) => {
  try {
    const id = String(req.params.id);

    // IMPORTANT: startIndex = 2 because $1 is used for assessment_id
    const { where, params } = assessScope(req, 'a', 2);

    const { rows } = await db.query(
      `
      SELECT
        a.*,

        q.question_id,
        q.question_order,
        q.question_type,
        q.question_text,
        q.points,
        q.correct_answer_text,
        q.explanation,
        q.metadata_json  AS q_metadata_json,
        q.created_at     AS q_created_at,
        q.updated_at     AS q_updated_at,

        o.option_id,
        o.option_order,
        o.option_text,
        o.is_correct,
        o.created_at     AS o_created_at,
        o.updated_at     AS o_updated_at

      FROM assessments a
      LEFT JOIN assessment_questions q ON q.assessment_id = a.assessment_id
      LEFT JOIN assessment_options o ON o.question_id = q.question_id
      WHERE a.assessment_id = $1 AND (${where})
      ORDER BY q.question_order ASC NULLS LAST, o.option_order ASC NULLS LAST
      `,
      [id, ...params]
    );

    const shaped = shapeAssessmentRows(rows);
    if (!shaped.length) return res.status(404).json({ error: 'Assessment not found' });

    return res.json(shaped[0]);
  } catch (err) {
    console.error('Error getting assessment:', err);
    return res.status(500).json({ error: 'Failed to fetch assessment' });
  }
};

// POST /assessments (roles 1-3)
export const createAssessment = async (req, res) => {
  if (!canWrite(req.user?.role_id)) return res.status(403).json({ error: 'Forbidden' });

  const {
    ship_id, // nullable
    title,
    description,
    status = 'draft',
    metadata_json = {},
    questions = [],
  } = req.body;

  // Always from token (matches your DB design)
  const company_id = req.user.company_id;
  const created_by_user_id = req.user.user_id;

  if (!company_id) return res.status(400).json({ error: 'Token missing company_id' });
  if (!title) return res.status(400).json({ error: 'title is required' });

  // scope enforcement
  if (Number(req.user.role_id) === ROLE_SUBADMIN) {
    // subadmin must be locked to their ship if ship_id is provided
    if (ship_id != null && Number(ship_id) !== Number(req.user.ship_id)) {
      return res.status(403).json({ error: 'Forbidden (ship scope)' });
    }
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const aRes = await client.query(
      `
      INSERT INTO assessments (
        company_id, ship_id, created_by_user_id, title, description, status, metadata_json, created_at, updated_at
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,NOW(),NOW())
      RETURNING *
      `,
      [
        String(company_id),
        ship_id != null ? Number(ship_id) : null,
        Number(created_by_user_id),
        title,
        description || null,
        status,
        metadata_json,
      ]
    );

    const assessment = aRes.rows[0];

    for (const q of questions) {
      const qRes = await client.query(
        `
        INSERT INTO assessment_questions (
          assessment_id, question_order, question_type, question_text, points, correct_answer_text,
          explanation, metadata_json, created_at, updated_at
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW(),NOW())
        RETURNING *
        `,
        [
          assessment.assessment_id,
          q.question_order ?? null,
          q.question_type ?? null,
          q.question_text ?? null,
          q.points ?? null,
          q.correct_answer_text ?? null,
          q.explanation ?? null,
          q.metadata_json ?? {},
        ]
      );

      const question = qRes.rows[0];

      const opts = Array.isArray(q.options) ? q.options : [];
      for (const o of opts) {
        await client.query(
          `
          INSERT INTO assessment_options (
            question_id, option_order, option_text, is_correct, created_at, updated_at
          )
          VALUES ($1,$2,$3,$4,NOW(),NOW())
          `,
          [
            question.question_id,
            o.option_order ?? null,
            o.option_text ?? null,
            o.is_correct ?? false,
          ]
        );
      }
    }

    await client.query('COMMIT');

    // return nested
    req.params.id = assessment.assessment_id;
    return getAssessmentById(req, res);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error creating assessment:', err);
    return res.status(500).json({ error: 'Failed to create assessment' });
  } finally {
    client.release();
  }
};

// PUT /assessments/:id (roles 1-3)
// If body.questions provided -> replace full question tree
export const updateAssessment = async (req, res) => {
  if (!canWrite(req.user?.role_id)) return res.status(403).json({ error: 'Forbidden' });

  const id = String(req.params.id);
  const {
    company_id,
    ship_id,
    title,
    description,
    status,
    metadata_json,
    questions, // optional
  } = req.body;

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // IMPORTANT: startIndex = 2 because $1 is assessment_id
    const { where, params } = assessScope(req, 'a', 2);

    const aCheck = await client.query(
      `SELECT a.assessment_id FROM assessments a WHERE a.assessment_id = $1 AND (${where})`,
      [id, ...params]
    );

    if (!aCheck.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Assessment not found' });
    }

    // prevent scope changes outside allowed scope
    if (Number(req.user.role_id) === ROLE_ADMIN && company_id && String(company_id) !== String(req.user.company_id)) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Forbidden (company scope)' });
    }

    if (Number(req.user.role_id) === ROLE_SUBADMIN) {
      if (
        (company_id && String(company_id) !== String(req.user.company_id)) ||
        (ship_id && Number(ship_id) !== Number(req.user.ship_id))
      ) {
        await client.query('ROLLBACK');
        return res.status(403).json({ error: 'Forbidden (ship scope)' });
      }
    }

    await client.query(
      `
      UPDATE assessments SET
        company_id    = COALESCE($1, company_id),
        ship_id       = COALESCE($2, ship_id),
        title         = COALESCE($3, title),
        description   = COALESCE($4, description),
        status        = COALESCE($5, status),
        metadata_json = COALESCE($6, metadata_json),
        updated_at    = NOW()
      WHERE assessment_id = $7
      `,
      [
        company_id ?? null,
        ship_id ?? null,
        title ?? null,
        description ?? null,
        status ?? null,
        metadata_json ?? null,
        id,
      ]
    );

    if (questions !== undefined) {
      await client.query(
        `
        DELETE FROM assessment_options
        WHERE question_id IN (SELECT question_id FROM assessment_questions WHERE assessment_id = $1)
        `,
        [id]
      );
      await client.query(`DELETE FROM assessment_questions WHERE assessment_id = $1`, [id]);

      for (const q of questions || []) {
        const qRes = await client.query(
          `
          INSERT INTO assessment_questions (
            assessment_id, question_order, question_type, question_text, points, correct_answer_text,
            explanation, metadata_json, created_at, updated_at
          )
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW(),NOW())
          RETURNING *
          `,
          [
            id,
            q.question_order ?? null,
            q.question_type ?? null,
            q.question_text ?? null,
            q.points ?? null,
            q.correct_answer_text ?? null,
            q.explanation ?? null,
            q.metadata_json ?? {},
          ]
        );

        const question = qRes.rows[0];
        for (const o of q.options || []) {
          await client.query(
            `
            INSERT INTO assessment_options (
              question_id, option_order, option_text, is_correct, created_at, updated_at
            )
            VALUES ($1,$2,$3,$4,NOW(),NOW())
            `,
            [
              question.question_id,
              o.option_order ?? null,
              o.option_text ?? null,
              o.is_correct ?? false,
            ]
          );
        }
      }
    }

    await client.query('COMMIT');
    return getAssessmentById(req, res);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error updating assessment:', err);
    return res.status(500).json({ error: 'Failed to update assessment' });
  } finally {
    client.release();
  }
};

// DELETE /assessments/:id (roles 1-3)
export const deleteAssessment = async (req, res) => {
  if (!canWrite(req.user?.role_id)) return res.status(403).json({ error: 'Forbidden' });

  const id = String(req.params.id);
  const client = await db.connect();

  try {
    await client.query('BEGIN');

    // IMPORTANT: startIndex = 2 because $1 is assessment_id
    const { where, params } = assessScope(req, 'a', 2);

    const ok = await client.query(
      `SELECT a.assessment_id FROM assessments a WHERE a.assessment_id = $1 AND (${where})`,
      [id, ...params]
    );

    if (!ok.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Assessment not found' });
    }

    await client.query(
      `
      DELETE FROM assessment_options
      WHERE question_id IN (SELECT question_id FROM assessment_questions WHERE assessment_id = $1)
      `,
      [id]
    );
    await client.query(`DELETE FROM assessment_questions WHERE assessment_id = $1`, [id]);
    await client.query(`DELETE FROM assessments WHERE assessment_id = $1`, [id]);

    await client.query('COMMIT');
    return res.json({ message: 'Assessment deleted' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error deleting assessment:', err);
    return res.status(500).json({ error: 'Failed to delete assessment' });
  } finally {
    client.release();
  }
};
