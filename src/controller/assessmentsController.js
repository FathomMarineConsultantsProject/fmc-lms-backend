import { db } from "../db.js";
import xlsx from "xlsx";

const isAdminRole = (roleId) => [1, 2, 3].includes(Number(roleId));

const getUserId = (req) => req.user?.user_id || req.user?.id;
const getRoleId = (req) => Number(req.user?.role_id);

function getCreateScope(req) {
  const roleId = getRoleId(req);

  if (roleId === 1) {
    return {
      company_id: req.body.company_id || null,
      ship_id: req.body.ship_id || null,
    };
  }

  if (roleId === 2) {
    return {
      company_id: req.user.company_id,
      ship_id: req.body.ship_id || null,
    };
  }

  return {
    company_id: req.user.company_id,
    ship_id: req.user.ship_id || null,
  };
}

function addScopeWhere(req, alias, params, options = {}) {
  const roleId = getRoleId(req);
  const publishedOnly = options.publishedOnly || false;
  const includeGlobal = options.includeGlobal || false;

  if (roleId === 1) return "";

  let sql = "";

  params.push(req.user.company_id);

  if (includeGlobal) {
    sql += ` AND (${alias}.company_id = $${params.length} OR ${alias}.company_id IS NULL)`;
  } else {
    sql += ` AND ${alias}.company_id = $${params.length}`;
  }

  if (roleId === 3 || roleId === 4) {
    params.push(req.user.ship_id);
    sql += ` AND (${alias}.ship_id = $${params.length} OR ${alias}.ship_id IS NULL)`;
  }

  if (roleId === 4 && publishedOnly) {
    sql += ` AND ${alias}.is_published = true`;
  }

  return sql;
}

async function checkAssessmentScope(req, assessmentId, client = db, options = {}) {
  const params = [assessmentId];

  let query = `
    SELECT a.assessment_id
    FROM assessments a
    WHERE a.assessment_id = $1
      AND a.is_deleted = false
  `;

  query += addScopeWhere(req, "a", params, options);

  const result = await client.query(query, params);
  return result.rowCount > 0;
}

const normalizeBool = (v, fallback = false) =>
  typeof v === "boolean" ? v : fallback;

const calculatePercentage = (score, total) => {
  if (!total || Number(total) <= 0) return 0;
  return Number(((Number(score) / Number(total)) * 100).toFixed(2));
};

const MCQ_TYPES = ["mcq_single", "mcq_multiple"];
const ASSESSMENT_TYPES = ["mcq_single", "mcq_multiple", "subjective"];

// ================= CREATE ASSESSMENT =================

export const createAssessment = async (req, res) => {
  const client = await db.connect();

  try {
    const userId = getUserId(req);
    const roleId = getRoleId(req);

    const {
      title,
      description,
      assessment_type,
      category,
      difficulty_level,
      passing_percentage,
      duration_minutes,
      instructions,
      is_published,
      allow_multiple_attempts,
      max_attempts,
      randomize_questions,
      show_result_immediately,
      company_id,
      ship_id,
      questions = [],
    } = req.body;

    if (!title || !assessment_type) {
      return res.status(400).json({
        success: false,
        message: "title and assessment_type are required",
      });
    }

    if (!ASSESSMENT_TYPES.includes(assessment_type)) {
      return res.status(400).json({
        success: false,
        message: "assessment_type must be mcq_single, mcq_multiple or subjective",
      });
    }

    if (!Array.isArray(questions) || questions.length === 0) {
      return res.status(400).json({
        success: false,
        message: "At least one question is required",
      });
    }

    await client.query("BEGIN");

    let totalMarks = 0;

    for (const q of questions) {
      totalMarks += Number(q.marks || 1);

      if (!ASSESSMENT_TYPES.includes(q.question_type)) {
        throw new Error("Invalid question_type");
      }

      if (q.question_type !== assessment_type) {
        throw new Error("All question_type values must match assessment_type");
      }

      if (MCQ_TYPES.includes(assessment_type)) {
        if (!Array.isArray(q.options) || q.options.length < 2) {
          throw new Error("MCQ questions must have at least 2 options");
        }

        const correctCount = q.options.filter((opt) => opt.is_correct).length;

        if (assessment_type === "mcq_single" && correctCount !== 1) {
          throw new Error("mcq_single questions must have exactly one correct option");
        }

        if (assessment_type === "mcq_multiple" && correctCount < 1) {
          throw new Error("mcq_multiple questions must have at least one correct option");
        }
      }

      if (assessment_type === "subjective" && q.options?.length) {
        throw new Error("Subjective questions cannot have options");
      }
    }

    const scope = getCreateScope(req);
    const assessmentResult = await client.query(

      `
      INSERT INTO assessments (
        title,
        description,
        assessment_type,
        category,
        difficulty_level,
        passing_percentage,
        duration_minutes,
        total_marks,
        instructions,
        is_published,
        allow_multiple_attempts,
        max_attempts,
        randomize_questions,
        show_result_immediately,
        company_id,
        ship_id,
        created_by,
        updated_by
      )
      VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
        $11,$12,$13,$14,$15,$16,$17,$18
      )
      RETURNING *
      `,
      [
        title,
        description || null,
        assessment_type,
        category || null,
        difficulty_level || null,
        passing_percentage || 0,
        duration_minutes || null,
        totalMarks,
        instructions || null,
        normalizeBool(is_published, false),
        normalizeBool(allow_multiple_attempts, false),
        max_attempts || 1,
        normalizeBool(randomize_questions, false),
        normalizeBool(show_result_immediately, true),
        scope.company_id,
        scope.ship_id,
        userId,
        userId,
      ]
    );

    const assessment = assessmentResult.rows[0];

    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];

      const questionResult = await client.query(
        `
        INSERT INTO assessment_questions (
          assessment_id,
          question_text,
          question_type,
          marks,
          question_order,
          explanation,
          is_required
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7)
        RETURNING *
        `,
        [
          assessment.assessment_id,
          q.question_text,
          q.question_type,
          q.marks || 1,
          q.question_order || i + 1,
          q.explanation || null,
          q.is_required !== false,
        ]
      );

      const question = questionResult.rows[0];

      if (MCQ_TYPES.includes(assessment_type)) {
        for (let j = 0; j < q.options.length; j++) {
          const opt = q.options[j];

          await client.query(
            `
            INSERT INTO assessment_options (
              question_id,
              option_text,
              is_correct,
              option_order
            )
            VALUES ($1,$2,$3,$4)
            `,
            [
              question.question_id,
              opt.option_text,
              normalizeBool(opt.is_correct, false),
              opt.option_order || j + 1,
            ]
          );
        }
      }
    }

    await client.query("COMMIT");

    return res.status(201).json({
      success: true,
      message: "Assessment created successfully",
      data: assessment,
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Create assessment error:", error);

    return res.status(500).json({
      success: false,
      message: error.message || "Failed to create assessment",
    });
  } finally {
    client.release();
  }
};

// ================= GET ASSESSMENTS =================

export const getAssessments = async (req, res) => {
  try {
    const roleId = getRoleId(req);
    const user = req.user;

    let query = `
      SELECT 
        a.*,
        COUNT(q.question_id)::INTEGER AS question_count
      FROM assessments a
      LEFT JOIN assessment_questions q 
        ON q.assessment_id = a.assessment_id 
        AND q.is_deleted = false
      WHERE a.is_deleted = false
    `;

    const params = [];

    query += addScopeWhere(req, "a", params, {
      includeGlobal: true,
      publishedOnly: true,
    });

    query += `
      GROUP BY a.assessment_id
      ORDER BY a.created_at DESC
    `;

    const result = await db.query(query, params);

    return res.json({
      success: true,
      count: result.rows.length,
      data: result.rows,
    });
  } catch (error) {
    console.error("Get assessments error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch assessments",
    });
  }
};

// ================= GET ASSESSMENT BY ID =================

export const getAssessmentById = async (req, res) => {
  try {
    const { assessmentId } = req.params;
    const roleId = getRoleId(req);
    const user = req.user;

    const allowed = await checkAssessmentScope(req, assessmentId, db, { includeGlobal: true });

    if (!allowed) {
      return res.status(404).json({
        success: false,
        message: "Assessment not found",
      });
    }

    const assessmentResult = await db.query(
      `
      SELECT *
      FROM assessments
      WHERE assessment_id = $1
      AND is_deleted = false
      `,
      [assessmentId]
    );

    const assessment = assessmentResult.rows[0];

    if (!assessment) {
      return res.status(404).json({
        success: false,
        message: "Assessment not found",
      });
    }

    if (roleId === 4 && !assessment.is_published) {
      return res.status(403).json({
        success: false,
        message: "Assessment is not published",
      });
    }

    const questionsResult = await db.query(
      `
      SELECT *
      FROM assessment_questions
      WHERE assessment_id = $1
      AND is_deleted = false
      ORDER BY question_order ASC
      `,
      [assessmentId]
    );

    const questions = [];

    for (const q of questionsResult.rows) {
      const optionsResult = await db.query(
        `
        SELECT 
          option_id,
          question_id,
          option_text,
          option_order
          ${isAdminRole(roleId) ? ", is_correct" : ""}
        FROM assessment_options
        WHERE question_id = $1
        ORDER BY option_order ASC
        `,
        [q.question_id]
      );

      questions.push({
        ...q,
        options: optionsResult.rows,
      });
    }

    return res.json({
      success: true,
      data: {
        ...assessment,
        questions,
      },
    });
  } catch (error) {
    console.error("Get assessment by id error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch assessment",
    });
  }
};

// ================= UPDATE ASSESSMENT BASIC DETAILS =================

export const updateAssessment = async (req, res) => {
  try {
    const { assessmentId } = req.params;
    const userId = getUserId(req);
    const roleId = getRoleId(req);

    const {
      title,
      description,
      category,
      difficulty_level,
      passing_percentage,
      duration_minutes,
      instructions,
      is_published,
      allow_multiple_attempts,
      max_attempts,
      randomize_questions,
      show_result_immediately,
      company_id,
      ship_id,
    } = req.body;

    const allowed = await checkAssessmentScope(req, assessmentId);

    if (!allowed) {
      return res.status(404).json({
        success: false,
        message: "Assessment not found",
      });
    }

    const params = [
      title ?? null,
      description ?? null,
      category ?? null,
      difficulty_level ?? null,
      passing_percentage ?? null,
      duration_minutes ?? null,
      instructions ?? null,
      is_published ?? null,
      allow_multiple_attempts ?? null,
      max_attempts ?? null,
      randomize_questions ?? null,
      show_result_immediately ?? null,
    ];

    let query = `
      UPDATE assessments
      SET
        title = COALESCE($1, title),
        description = COALESCE($2, description),
        category = COALESCE($3, category),
        difficulty_level = COALESCE($4, difficulty_level),
        passing_percentage = COALESCE($5, passing_percentage),
        duration_minutes = COALESCE($6, duration_minutes),
        instructions = COALESCE($7, instructions),
        is_published = COALESCE($8, is_published),
        allow_multiple_attempts = COALESCE($9, allow_multiple_attempts),
        max_attempts = COALESCE($10, max_attempts),
        randomize_questions = COALESCE($11, randomize_questions),
        show_result_immediately = COALESCE($12, show_result_immediately)
    `;

    // Only superadmin can change assessment company/ship scope
    if (roleId === 1) {
      params.push(company_id ?? null);
      query += `, company_id = COALESCE($${params.length}, company_id)`;

      params.push(ship_id ?? null);
      query += `, ship_id = COALESCE($${params.length}, ship_id)`;
    }

    params.push(userId);
    query += `, updated_by = $${params.length}, updated_at = NOW()`;

    params.push(assessmentId);
    query += `
      WHERE assessment_id = $${params.length}
        AND is_deleted = false
      RETURNING *
    `;

    const result = await db.query(query, params);

    return res.json({
      success: true,
      message: "Assessment updated successfully",
      data: result.rows[0],
    });
  } catch (error) {
    console.error("Update assessment error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to update assessment",
    });
  }
};

// ================= UPDATE ASSESSMENT QUESTIONS + OPTIONS =================

export const updateAssessmentQuestions = async (req, res) => {
  const client = await db.connect();

  try {
    const { assessmentId } = req.params;
    const { questions = [] } = req.body;

    if (!Array.isArray(questions) || questions.length === 0) {
      return res.status(400).json({
        success: false,
        message: "questions array is required",
      });
    }

    await client.query("BEGIN");

    const assessmentResult = await client.query(
      `
      SELECT assessment_id, assessment_type
      FROM assessments
      WHERE assessment_id = $1
      AND is_deleted = false
      `,
      [assessmentId]
    );

    const allowed = await checkAssessmentScope(req, assessmentId, client);

    if (!allowed) {
      throw new Error("Assessment not found");
    }

    if (assessmentResult.rows.length === 0) {
      throw new Error("Assessment not found");
    }

    const assessment = assessmentResult.rows[0];

    let totalMarks = 0;

    for (const q of questions) {
      totalMarks += Number(q.marks || 1);

      if (!ASSESSMENT_TYPES.includes(q.question_type)) {
        throw new Error("Invalid question_type");
      }

      if (q.question_type !== assessment.assessment_type) {
        throw new Error("Question type must match assessment type");
      }

      if (MCQ_TYPES.includes(assessment.assessment_type)) {
        if (!Array.isArray(q.options) || q.options.length < 2) {
          throw new Error("MCQ questions must have at least 2 options");
        }

        const correctCount = q.options.filter((opt) => opt.is_correct).length;

        if (assessment.assessment_type === "mcq_single" && correctCount !== 1) {
          throw new Error("mcq_single question must have exactly one correct option");
        }

        if (assessment.assessment_type === "mcq_multiple" && correctCount < 1) {
          throw new Error("mcq_multiple question must have at least one correct option");
        }
      }

      if (assessment.assessment_type === "subjective" && q.options?.length) {
        throw new Error("Subjective questions cannot have options");
      }
    }

    await client.query(
      `
      DELETE FROM assessment_questions
      WHERE assessment_id = $1
      `,
      [assessmentId]
    );

    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];

      const questionResult = await client.query(
        `
        INSERT INTO assessment_questions (
          assessment_id,
          question_text,
          question_type,
          marks,
          question_order,
          explanation,
          is_required
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7)
        RETURNING *
        `,
        [
          assessmentId,
          q.question_text,
          q.question_type,
          q.marks || 1,
          q.question_order || i + 1,
          q.explanation || null,
          q.is_required !== false,
        ]
      );

      const question = questionResult.rows[0];

      if (MCQ_TYPES.includes(assessment.assessment_type)) {
        for (let j = 0; j < q.options.length; j++) {
          const opt = q.options[j];

          await client.query(
            `
            INSERT INTO assessment_options (
              question_id,
              option_text,
              is_correct,
              option_order
            )
            VALUES ($1,$2,$3,$4)
            `,
            [
              question.question_id,
              opt.option_text,
              normalizeBool(opt.is_correct, false),
              opt.option_order || j + 1,
            ]
          );
        }
      }
    }

    await client.query(
      `
      UPDATE assessments
      SET total_marks = $1,
          updated_at = NOW()
      WHERE assessment_id = $2
      `,
      [totalMarks, assessmentId]
    );

    await client.query("COMMIT");

    return res.json({
      success: true,
      message: "Assessment questions updated successfully",
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Update assessment questions error:", error);

    return res.status(500).json({
      success: false,
      message: error.message || "Failed to update assessment questions",
    });
  } finally {
    client.release();
  }
};

// ================= UPDATE QUESTION OPTIONS =================

export const updateQuestionOptions = async (req, res) => {
  const client = await db.connect();

  try {
    const { questionId } = req.params;
    const { options = [] } = req.body;

    if (!Array.isArray(options) || options.length < 2) {
      return res.status(400).json({
        success: false,
        message: "At least 2 options are required",
      });
    }

    await client.query("BEGIN");

    const questionResult = await client.query(`
  SELECT q.*, a.assessment_type
  FROM assessment_questions q
  JOIN assessments a ON a.assessment_id = q.assessment_id
  WHERE q.question_id = $1
  AND q.is_deleted = false
  AND a.is_deleted = false
`, [questionId]);

    if (questionResult.rows.length === 0) {
      throw new Error("Question not found");
    }

    const question = questionResult.rows[0];

    const allowed = await checkAssessmentScope(req, question.assessment_id, client);

    if (!allowed) {
      throw new Error("Assessment not found");
    }

    if (!MCQ_TYPES.includes(question.question_type)) {
      throw new Error("Options can only be updated for MCQ questions");
    }

    const correctCount = options.filter((opt) => opt.is_correct).length;

    if (question.question_type === "mcq_single" && correctCount !== 1) {
      throw new Error("mcq_single question must have exactly one correct option");
    }

    if (question.question_type === "mcq_multiple" && correctCount < 1) {
      throw new Error("mcq_multiple question must have at least one correct option");
    }

    await client.query(
      `
      DELETE FROM assessment_options
      WHERE question_id = $1
      `,
      [questionId]
    );

    for (let i = 0; i < options.length; i++) {
      const opt = options[i];

      await client.query(
        `
        INSERT INTO assessment_options (
          question_id,
          option_text,
          is_correct,
          option_order
        )
        VALUES ($1,$2,$3,$4)
        `,
        [
          questionId,
          opt.option_text,
          normalizeBool(opt.is_correct, false),
          opt.option_order || i + 1,
        ]
      );
    }

    await client.query("COMMIT");

    return res.json({
      success: true,
      message: "Question options updated successfully",
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Update question options error:", error);

    return res.status(500).json({
      success: false,
      message: error.message || "Failed to update question options",
    });
  } finally {
    client.release();
  }
};

// ================= DELETE ASSESSMENT =================

export const deleteAssessment = async (req, res) => {
  try {
    const { assessmentId } = req.params;
    const userId = getUserId(req);

    const params = [userId, assessmentId];

    let query = `
  UPDATE assessments a
  SET is_deleted = true,
      updated_by = $1,
      updated_at = NOW()
  WHERE a.assessment_id = $2
    AND a.is_deleted = false
`;

    query += addScopeWhere(req, "a", params);

    query += ` RETURNING a.assessment_id`;

    const result = await db.query(query, params);

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Assessment not found",
      });
    }

    return res.json({
      success: true,
      message: "Assessment deleted successfully",
    });
  } catch (error) {
    console.error("Delete assessment error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to delete assessment",
    });
  }
};

// ================= DELETE QUESTION =================

export const deleteQuestion = async (req, res) => {
  const client = await db.connect();

  try {
    const { questionId } = req.params;

    await client.query("BEGIN");

    const questionResult = await client.query(
      `
      SELECT question_id, assessment_id, marks
      FROM assessment_questions
      WHERE question_id = $1
      AND is_deleted = false
      `,
      [questionId]
    );

    if (questionResult.rows.length === 0) {
      throw new Error("Question not found");
    }

    const question = questionResult.rows[0];

    const allowed = await checkAssessmentScope(req, question.assessment_id, client);

    if (!allowed) {
      throw new Error("Assessment not found");
    }

    await client.query(
      `
      UPDATE assessment_questions
      SET is_deleted = true,
          updated_at = NOW()
      WHERE question_id = $1
      `,
      [questionId]
    );

    await client.query(
      `
      UPDATE assessments
      SET total_marks = COALESCE((
        SELECT SUM(marks)
        FROM assessment_questions
        WHERE assessment_id = $1
        AND is_deleted = false
      ), 0),
      updated_at = NOW()
      WHERE assessment_id = $1
      `,
      [question.assessment_id]
    );

    await client.query("COMMIT");

    return res.json({
      success: true,
      message: "Question deleted successfully",
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Delete question error:", error);

    return res.status(500).json({
      success: false,
      message: error.message || "Failed to delete question",
    });
  } finally {
    client.release();
  }
};

// ================= DELETE OPTION =================

export const deleteOption = async (req, res) => {
  const client = await db.connect();

  try {
    const { optionId } = req.params;

    await client.query("BEGIN");

    const optionResult = await client.query(
      `
      SELECT o.*, q.question_type, q.assessment_id
FROM assessment_options o
JOIN assessment_questions q ON q.question_id = o.question_id
WHERE o.option_id = $1
AND q.is_deleted = false
      `,
      [optionId]
    );

    if (optionResult.rows.length === 0) {
      throw new Error("Option not found");
    }

    const option = optionResult.rows[0];

    const allowed = await checkAssessmentScope(req, option.assessment_id, client);

    if (!allowed) {
      throw new Error("Assessment not found");
    }

    const countResult = await client.query(
      `
      SELECT
        COUNT(*)::INTEGER AS total_options,
        COUNT(*) FILTER (WHERE is_correct = true)::INTEGER AS correct_options
      FROM assessment_options
      WHERE question_id = $1
      `,
      [option.question_id]
    );

    const totalOptions = Number(countResult.rows[0].total_options);
    const correctOptions = Number(countResult.rows[0].correct_options);

    if (totalOptions <= 2) {
      throw new Error("MCQ question must have at least 2 options");
    }

    if (option.is_correct && correctOptions <= 1) {
      throw new Error("Cannot delete the only correct option");
    }

    await client.query(
      `
      DELETE FROM assessment_options
      WHERE option_id = $1
      `,
      [optionId]
    );

    await client.query("COMMIT");

    return res.json({
      success: true,
      message: "Option deleted successfully",
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Delete option error:", error);

    return res.status(500).json({
      success: false,
      message: error.message || "Failed to delete option",
    });
  } finally {
    client.release();
  }
};

// ================= START ASSESSMENT =================

export const startAssessment = async (req, res) => {
  try {
    const { assessmentId } = req.params;
    const userId = getUserId(req);

    const params = [assessmentId];

    let query = `
      SELECT *
      FROM assessments a
      WHERE a.assessment_id = $1
        AND a.is_deleted = false
        AND a.is_published = true
    `;

    query += addScopeWhere(req, "a", params, {
      includeGlobal: true,
      publishedOnly: true,
    });

    const assessmentResult = await db.query(query, params);

    if (assessmentResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Assessment not found or not published",
      });
    }

    const assessment = assessmentResult.rows[0];

    const previousAttempts = await db.query(
      `
      SELECT COUNT(*)::INTEGER AS count
      FROM assessment_attempts
      WHERE assessment_id = $1
      AND user_id = $2
      `,
      [assessmentId, userId]
    );

    const attemptCount = previousAttempts.rows[0].count;

    if (!assessment.allow_multiple_attempts && attemptCount >= 1) {
      return res.status(400).json({
        success: false,
        message: "You have already attempted this assessment",
      });
    }

    if (
      assessment.allow_multiple_attempts &&
      attemptCount >= Number(assessment.max_attempts)
    ) {
      return res.status(400).json({
        success: false,
        message: "Maximum attempts reached",
      });
    }

    const questionCountResult = await db.query(
      `
      SELECT COUNT(*)::INTEGER AS total_questions
      FROM assessment_questions
      WHERE assessment_id = $1
      AND is_deleted = false
      `,
      [assessmentId]
    );

    const attemptResult = await db.query(
      `
      INSERT INTO assessment_attempts (
        assessment_id,
        user_id,
        status,
        total_questions,
        attempt_number
      )
      VALUES ($1,$2,'in_progress',$3,$4)
      RETURNING *
      `,
      [
        assessmentId,
        userId,
        questionCountResult.rows[0].total_questions,
        attemptCount + 1,
      ]
    );

    return res.status(201).json({
      success: true,
      message: "Assessment started",
      data: attemptResult.rows[0],
    });
  } catch (error) {
    console.error("Start assessment error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to start assessment",
    });
  }
};

// ================= SUBMIT ASSESSMENT =================

export const submitAssessment = async (req, res) => {
  const client = await db.connect();

  try {
    const { assessmentId } = req.params;
    const userId = getUserId(req);
    const { attempt_id, answers = [] } = req.body;

    if (!attempt_id) {
      return res.status(400).json({
        success: false,
        message: "attempt_id is required",
      });
    }

    if (!Array.isArray(answers) || answers.length === 0) {
      return res.status(400).json({
        success: false,
        message: "answers array is required",
      });
    }

    await client.query("BEGIN");

    const attemptResult = await client.query(
      `
      SELECT aa.*, a.assessment_type, a.passing_percentage, a.total_marks
      FROM assessment_attempts aa
      JOIN assessments a ON a.assessment_id = aa.assessment_id
      WHERE aa.attempt_id = $1
      AND aa.assessment_id = $2
      AND aa.user_id = $3
      AND aa.status = 'in_progress'
      `,
      [attempt_id, assessmentId, userId]
    );

    if (attemptResult.rows.length === 0) {
      throw new Error("Valid in-progress attempt not found");
    }

    const attempt = attemptResult.rows[0];

    const allowed = await checkAssessmentScope(req, attempt.assessment_id, client, { includeGlobal: true });

    if (!allowed) {
      throw new Error("Assessment not found");
    }

    let scoreObtained = 0;
    let correctCount = 0;
    let subjectivePendingReview = false;

    for (const ans of answers) {
      const questionResult = await client.query(
        `
        SELECT *
        FROM assessment_questions
        WHERE question_id = $1
        AND assessment_id = $2
        AND is_deleted = false
        `,
        [ans.question_id, assessmentId]
      );

      if (questionResult.rows.length === 0) {
        throw new Error("Invalid question_id submitted");
      }

      const question = questionResult.rows[0];

      let selectedOptionId = ans.selected_option_id || null;
      let selectedOptionIds = Array.isArray(ans.selected_option_ids)
        ? ans.selected_option_ids
        : null;
      let answerText = ans.answer_text || null;
      let isCorrect = null;
      let marksAwarded = 0;

      if (question.question_type === "mcq_single") {
        if (!selectedOptionId) {
          throw new Error("selected_option_id is required for MCQ question");
        }

        const optionResult = await client.query(
          `
          SELECT *
          FROM assessment_options
          WHERE option_id = $1
          AND question_id = $2
          `,
          [selectedOptionId, question.question_id]
        );

        if (optionResult.rows.length === 0) {
          throw new Error("Invalid selected_option_id submitted");
        }

        const selectedOption = optionResult.rows[0];

        isCorrect = selectedOption.is_correct;

        if (isCorrect) {
          marksAwarded = Number(question.marks);
          scoreObtained += marksAwarded;
          correctCount += 1;
        }
      }

      if (question.question_type === "mcq_multiple") {
        if (!selectedOptionIds || selectedOptionIds.length === 0) {
          throw new Error("selected_option_ids array is required for MCQ multiple question");
        }

        const optionsResult = await client.query(
          `
    SELECT option_id, is_correct
    FROM assessment_options
    WHERE question_id = $1
    `,
          [question.question_id]
        );

        const allOptions = optionsResult.rows;

        const validOptionIds = allOptions.map((opt) => String(opt.option_id));
        const correctOptionIds = allOptions
          .filter((opt) => opt.is_correct)
          .map((opt) => String(opt.option_id))
          .sort();

        const submittedOptionIds = selectedOptionIds.map(String).sort();

        const hasInvalidOption = submittedOptionIds.some(
          (id) => !validOptionIds.includes(id)
        );

        if (hasInvalidOption) {
          throw new Error("Invalid selected_option_ids submitted");
        }

        isCorrect =
          submittedOptionIds.length === correctOptionIds.length &&
          submittedOptionIds.every((id, index) => id === correctOptionIds[index]);

        if (isCorrect) {
          marksAwarded = Number(question.marks);
          scoreObtained += marksAwarded;
          correctCount += 1;
        }
      }

      if (question.question_type === "subjective") {
        if (!answerText) {
          throw new Error("answer_text is required for subjective question");
        }

        subjectivePendingReview = true;
        isCorrect = null;
        marksAwarded = 0;
      }

      await client.query(
        `
        INSERT INTO assessment_answers (
  attempt_id,
  question_id,
  selected_option_id,
  selected_option_ids,
  answer_text,
  is_correct,
  marks_awarded
)
VALUES ($1,$2,$3,$4,$5,$6,$7)
ON CONFLICT (attempt_id, question_id)
DO UPDATE SET
  selected_option_id = EXCLUDED.selected_option_id,
  selected_option_ids = EXCLUDED.selected_option_ids,
  answer_text = EXCLUDED.answer_text,
  is_correct = EXCLUDED.is_correct,
  marks_awarded = EXCLUDED.marks_awarded,
  answered_at = NOW()
        `,
        [
          attempt_id,
          question.question_id,
          selectedOptionId,
          selectedOptionIds,
          answerText,
          isCorrect,
          marksAwarded,
        ]
      );
    }

    const percentage = calculatePercentage(scoreObtained, attempt.total_marks);
    const isPassed = subjectivePendingReview
      ? null
      : percentage >= Number(attempt.passing_percentage);

    const finalStatus = subjectivePendingReview ? "submitted" : "evaluated";

    const updatedAttempt = await client.query(
      `
      UPDATE assessment_attempts
      SET
        submitted_at = NOW(),
        status = $1,
        score_obtained = $2,
        percentage = $3,
        is_passed = $4,
        correct_answers_count = $5,
        subjective_pending_review = $6,
        updated_at = NOW()
      WHERE attempt_id = $7
      RETURNING *
      `,
      [
        finalStatus,
        scoreObtained,
        percentage,
        isPassed,
        correctCount,
        subjectivePendingReview,
        attempt_id,
      ]
    );

    await client.query("COMMIT");

    return res.json({
      success: true,
      message: subjectivePendingReview
        ? "Assessment submitted. Subjective answers are pending review."
        : "Assessment submitted and evaluated successfully",
      data: updatedAttempt.rows[0],
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Submit assessment error:", error);

    return res.status(500).json({
      success: false,
      message: error.message || "Failed to submit assessment",
    });
  } finally {
    client.release();
  }
};

// ================= RESULT =================

export const getAttemptResult = async (req, res) => {
  try {
    const { attemptId } = req.params;
    const userId = getUserId(req);
    const roleId = getRoleId(req);

    const params = [attemptId];

    let query = `
      SELECT 
        aa.*,
        a.title,
        a.assessment_type,
        a.passing_percentage,
        a.total_marks
      FROM assessment_attempts aa
      JOIN assessments a ON a.assessment_id = aa.assessment_id
      WHERE aa.attempt_id = $1
    `;

    query += addScopeWhere(req, "a", params, { includeGlobal: true });

    if (roleId === 4) {
      params.push(userId);
      query += ` AND aa.user_id = $${params.length}`;
    }

    const attemptResult = await db.query(query, params);

    if (attemptResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Result not found",
      });
    }

    const answersResult = await db.query(
      `
  SELECT 
    ans.*,
    q.question_text,
    q.question_type,
    q.marks,
    opt.option_text AS selected_option_text,
    COALESCE(
      json_agg(
        json_build_object(
          'option_id', multi_opt.option_id,
          'option_text', multi_opt.option_text
        )
      ) FILTER (WHERE multi_opt.option_id IS NOT NULL),
      '[]'
    ) AS selected_options
  FROM assessment_answers ans
  JOIN assessment_questions q ON q.question_id = ans.question_id
  LEFT JOIN assessment_options opt ON opt.option_id = ans.selected_option_id
  LEFT JOIN assessment_options multi_opt 
    ON multi_opt.option_id = ANY(COALESCE(ans.selected_option_ids, ARRAY[]::uuid[]))
  WHERE ans.attempt_id = $1
  GROUP BY ans.answer_id, q.question_id, opt.option_text
  ORDER BY q.question_order ASC
  `,
      [attemptId]
    );

    return res.json({
      success: true,
      data: {
        attempt: attemptResult.rows[0],
        answers: answersResult.rows,
      },
    });
  } catch (error) {
    console.error("Get result error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch result",
    });
  }
};

// ================= MY RESULTS =================

export const getMyResults = async (req, res) => {
  try {
    const userId = getUserId(req);

    const params = [userId];

    let query = `
  SELECT 
    aa.*,
    a.title,
    a.assessment_type,
    a.difficulty_level,
    a.passing_percentage,
    a.total_marks
  FROM assessment_attempts aa
  JOIN assessments a ON a.assessment_id = aa.assessment_id
  WHERE aa.user_id = $1
`;

    query += addScopeWhere(req, "a", params, { includeGlobal: true });

    query += ` ORDER BY aa.created_at DESC`;

    const result = await db.query(query, params);

    return res.json({
      success: true,
      count: result.rows.length,
      data: result.rows,
    });
  } catch (error) {
    console.error("Get my results error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch my results",
    });
  }
};

// ================= ANALYTICS =================

export const getAssessmentAnalytics = async (req, res) => {
  try {
    const { assessmentId } = req.params;

    const allowed = await checkAssessmentScope(req, assessmentId, db, { includeGlobal: true });

    if (!allowed) {
      return res.status(404).json({
        success: false,
        message: "Assessment not found",
      });
    }

    const overviewResult = await db.query(
      `
      SELECT
        COUNT(*)::INTEGER AS total_attempts,
        COUNT(DISTINCT user_id)::INTEGER AS unique_users,
        AVG(percentage)::NUMERIC(5,2) AS average_percentage,
        MAX(percentage)::NUMERIC(5,2) AS highest_percentage,
        MIN(percentage)::NUMERIC(5,2) AS lowest_percentage,
        COUNT(*) FILTER (WHERE is_passed = true)::INTEGER AS passed_count,
        COUNT(*) FILTER (WHERE is_passed = false)::INTEGER AS failed_count,
        COUNT(*) FILTER (WHERE status = 'submitted')::INTEGER AS pending_review_count
      FROM assessment_attempts
      WHERE assessment_id = $1
      AND status IN ('submitted', 'evaluated')
      `,
      [assessmentId]
    );

    const questionStatsResult = await db.query(
      `
      SELECT
        q.question_id,
        q.question_text,
        q.question_type,
        q.marks,
        COUNT(ans.answer_id)::INTEGER AS total_answers,
        COUNT(ans.answer_id) FILTER (WHERE ans.is_correct = true)::INTEGER AS correct_answers,
        COUNT(ans.answer_id) FILTER (WHERE ans.is_correct = false)::INTEGER AS wrong_answers,
        AVG(ans.marks_awarded)::NUMERIC(10,2) AS average_marks
      FROM assessment_questions q
      LEFT JOIN assessment_answers ans ON ans.question_id = q.question_id
      WHERE q.assessment_id = $1
      AND q.is_deleted = false
      GROUP BY q.question_id
      ORDER BY q.question_order ASC
      `,
      [assessmentId]
    );

    return res.json({
      success: true,
      data: {
        overview: overviewResult.rows[0],
        question_stats: questionStatsResult.rows,
      },
    });
  } catch (error) {
    console.error("Assessment analytics error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch analytics",
    });
  }
};

// ======================== CREATE ASSESSMENT FROM EXCEL =================

export const createAssessmentFromExcel = async (req, res) => {
  const client = await db.connect();

  try {
    const userId = getUserId(req);

    const {
      title,
      description,
      assessment_type,
      category,
      difficulty_level,
      passing_percentage,
      duration_minutes,
      instructions,
      is_published,
      allow_multiple_attempts,
      max_attempts,
      randomize_questions,
      show_result_immediately,
      company_id,
      ship_id,
    } = req.body;

    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "Excel file is required",
      });
    }

    if (!title || !assessment_type) {
      return res.status(400).json({
        success: false,
        message: "title and assessment_type are required",
      });
    }

    if (!ASSESSMENT_TYPES.includes(assessment_type)) {
      return res.status(400).json({
        success: false,
        message: "assessment_type must be mcq_single, mcq_multiple or subjective",
      });
    }

    const workbook = xlsx.read(req.file.buffer, { type: "buffer" });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = xlsx.utils.sheet_to_json(sheet);

    if (!rows.length) {
      return res.status(400).json({
        success: false,
        message: "Excel is empty",
      });
    }

    await client.query("BEGIN");

    let totalMarks = 0;

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];

      const questionText = row["question"];
      const marks = Number(row["total marks"] || 1);

      if (!questionText) {
        throw new Error(`Row ${i + 1}: question is required`);
      }

      if (!marks || marks <= 0) {
        throw new Error(`Row ${i + 1}: total marks must be greater than 0`);
      }

      totalMarks += marks;

      if (MCQ_TYPES.includes(assessment_type)) {
        const options = [
          row["option 1"],
          row["option 2"],
          row["option 3"],
          row["option 4"],
        ].filter(Boolean);

        if (options.length < 2) {
          throw new Error(`Row ${i + 1}: at least 2 options required`);
        }

        const correctRaw = String(row["correct options"] || "")
          .split(",")
          .map((v) => v.trim())
          .filter(Boolean);

        const correctIndexes = correctRaw.map((v) => Number(v) - 1);

        if (correctIndexes.some((idx) => Number.isNaN(idx) || idx < 0 || idx >= options.length)) {
          throw new Error(`Row ${i + 1}: correct options must be valid option numbers`);
        }

        if (assessment_type === "mcq_single" && correctIndexes.length !== 1) {
          throw new Error(`Row ${i + 1}: mcq_single must have exactly 1 correct option`);
        }

        if (assessment_type === "mcq_multiple" && correctIndexes.length < 1) {
          throw new Error(`Row ${i + 1}: mcq_multiple needs at least 1 correct option`);
        }
      }
    }

    const scope = getCreateScope(req);

    const assessmentResult = await client.query(
      `
      INSERT INTO assessments (
        title,
        description,
        assessment_type,
        category,
        difficulty_level,
        passing_percentage,
        duration_minutes,
        total_marks,
        instructions,
        is_published,
        allow_multiple_attempts,
        max_attempts,
        randomize_questions,
        show_result_immediately,
        company_id,
        ship_id,
        created_by,
        updated_by
      )
      VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
        $11,$12,$13,$14,$15,$16,$17,$18
      )
      RETURNING *
      `,
      [
        title,
        description || null,
        assessment_type,
        category || null,
        difficulty_level || null,
        passing_percentage || 0,
        duration_minutes || null,
        totalMarks,
        instructions || null,
        normalizeBool(is_published === "true" || is_published === true, false),
        normalizeBool(allow_multiple_attempts === "true" || allow_multiple_attempts === true, false),
        max_attempts || 1,
        normalizeBool(randomize_questions === "true" || randomize_questions === true, false),
        normalizeBool(show_result_immediately === "true" || show_result_immediately === true, true),
        scope.company_id,
        scope.ship_id,
        userId,
        userId,
      ]
    );

    const assessment = assessmentResult.rows[0];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];

      const questionText = row["question"];
      const marks = Number(row["total marks"] || 1);

      const questionResult = await client.query(
        `
        INSERT INTO assessment_questions (
          assessment_id,
          question_text,
          question_type,
          marks,
          question_order
        )
        VALUES ($1,$2,$3,$4,$5)
        RETURNING *
        `,
        [
          assessment.assessment_id,
          questionText,
          assessment_type,
          marks,
          Number(row["question no."] || i + 1),
        ]
      );

      const question = questionResult.rows[0];

      if (MCQ_TYPES.includes(assessment_type)) {
        const options = [
          row["option 1"],
          row["option 2"],
          row["option 3"],
          row["option 4"],
        ].filter(Boolean);

        const correctIndexes = String(row["correct options"] || "")
          .split(",")
          .map((v) => v.trim())
          .filter(Boolean)
          .map((v) => Number(v) - 1);

        for (let j = 0; j < options.length; j++) {
          await client.query(
            `
            INSERT INTO assessment_options (
              question_id,
              option_text,
              is_correct,
              option_order
            )
            VALUES ($1,$2,$3,$4)
            `,
            [
              question.question_id,
              options[j],
              correctIndexes.includes(j),
              j + 1,
            ]
          );
        }
      }
    }

    await client.query("COMMIT");

    return res.status(201).json({
      success: true,
      message: "Assessment created from Excel successfully",
      data: assessment,
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Create assessment from Excel error:", error);

    return res.status(500).json({
      success: false,
      message: error.message || "Failed to create assessment from Excel",
    });
  } finally {
    client.release();
  }
};

// ======================== UPLOAD ASSESSMENT FROM EXCEL =================

// export const uploadAssessmentExcel = async (req, res) => {
//   const client = await db.connect();

//   try {
//     const { assessmentId } = req.params;

//     if (!req.file) {
//       return res.status(400).json({
//         success: false,
//         message: "Excel file is required",
//       });
//     }

//     await client.query("BEGIN");

//     // get assessment
//     const assessmentResult = await client.query(
//       `SELECT * FROM assessments WHERE assessment_id = $1 AND is_deleted = false`,
//       [assessmentId]
//     );

//     if (assessmentResult.rows.length === 0) {
//       throw new Error("Assessment not found");
//     }

//     const assessment = assessmentResult.rows[0];

//     // parse excel
//     const workbook = xlsx.read(req.file.buffer, { type: "buffer" });
//     const sheet = workbook.Sheets[workbook.SheetNames[0]];
//     const rows = xlsx.utils.sheet_to_json(sheet);

//     if (!rows.length) {
//       throw new Error("Excel is empty");
//     }

//     let totalMarks = 0;

//     // delete old questions (same logic you fixed)
//     await client.query(
//       `DELETE FROM assessment_questions WHERE assessment_id = $1`,
//       [assessmentId]
//     );

//     for (let i = 0; i < rows.length; i++) {
//       const row = rows[i];

//       const questionText = row["question"];
//       const marks = Number(row["total marks"] || 1);

//       if (!questionText) {
//         throw new Error(`Row ${i + 1}: question is required`);
//       }

//       totalMarks += marks;

//       const questionResult = await client.query(
//         `
//         INSERT INTO assessment_questions (
//           assessment_id,
//           question_text,
//           question_type,
//           marks,
//           question_order
//         )
//         VALUES ($1,$2,$3,$4,$5)
//         RETURNING *
//         `,
//         [
//           assessmentId,
//           questionText,
//           assessment.assessment_type,
//           marks,
//           i + 1,
//         ]
//       );

//       const question = questionResult.rows[0];

//       // ================= MCQ =================
//       if (MCQ_TYPES.includes(assessment.assessment_type)) {
//         const options = [
//           row["option 1"],
//           row["option 2"],
//           row["option 3"],
//           row["option 4"],
//         ].filter(Boolean);

//         if (options.length < 2) {
//           throw new Error(`Row ${i + 1}: at least 2 options required`);
//         }

//         const correctRaw = String(row["correct options"] || "")
//           .split(",")
//           .map((v) => v.trim());

//         let correctIndexes = correctRaw.map((v) => Number(v) - 1);

//         if (assessment.assessment_type === "mcq_single" && correctIndexes.length !== 1) {
//           throw new Error(`Row ${i + 1}: mcq_single must have exactly 1 correct option`);
//         }

//         if (assessment.assessment_type === "mcq_multiple" && correctIndexes.length < 1) {
//           throw new Error(`Row ${i + 1}: mcq_multiple needs at least 1 correct`);
//         }

//         for (let j = 0; j < options.length; j++) {
//           await client.query(
//             `
//             INSERT INTO assessment_options (
//               question_id,
//               option_text,
//               is_correct,
//               option_order
//             )
//             VALUES ($1,$2,$3,$4)
//             `,
//             [
//               question.question_id,
//               options[j],
//               correctIndexes.includes(j),
//               j + 1,
//             ]
//           );
//         }
//       }

//       // ================= SUBJECTIVE =================
//       if (assessment.assessment_type === "subjective") {
//         // no options needed
//       }
//     }

//     await client.query(
//       `
//       UPDATE assessments
//       SET total_marks = $1,
//           updated_at = NOW()
//       WHERE assessment_id = $2
//       `,
//       [totalMarks, assessmentId]
//     );

//     await client.query("COMMIT");

//     return res.json({
//       success: true,
//       message: "Excel uploaded and questions created successfully",
//     });
//   } catch (error) {
//     await client.query("ROLLBACK");
//     console.error("Excel upload error:", error);

//     return res.status(500).json({
//       success: false,
//       message: error.message,
//     });
//   } finally {
//     client.release();
//   }
// };

// ================= USER RESULTS BY ROLE =================

export const getUserResultsByRole = async (req, res) => {
  try {
    const roleId = getRoleId(req);
    const userId = getUserId(req);

    const params = [];

    let query = `
      SELECT
        aa.attempt_id,
        aa.assessment_id,
        aa.user_id,
        aa.status,
        aa.score_obtained,
        aa.percentage,
        aa.is_passed,
        aa.correct_answers_count,
        aa.total_questions,
        aa.attempt_number,
        aa.started_at,
        aa.submitted_at,
        aa.created_at,

        a.title AS assessment_title,
        a.assessment_type,
        a.category,
        a.difficulty_level,
        a.passing_percentage,
        a.total_marks,

        u.full_name,
        u.email,
        u.role_id,
        u.company_id,
        u.ship_id,

        c.company_name,
        s.ship_name

      FROM assessment_attempts aa
      JOIN assessments a ON a.assessment_id = aa.assessment_id
      JOIN users u ON u.user_id = aa.user_id
      LEFT JOIN company c ON c.company_id = u.company_id
      LEFT JOIN ships s ON s.ship_id = u.ship_id
      WHERE a.is_deleted = false
    `;

    if (roleId === 1) {
      // superadmin sees all
    } else if (roleId === 2) {
      params.push(req.user.company_id);
      query += ` AND u.company_id = $${params.length}`;
    } else if (roleId === 3) {
      params.push(req.user.company_id);
      query += ` AND u.company_id = $${params.length}`;

      params.push(req.user.ship_id);
      query += ` AND u.ship_id = $${params.length}`;
    } else {
      params.push(userId);
      query += ` AND aa.user_id = $${params.length}`;
    }

    query += `
      ORDER BY aa.created_at DESC
    `;

    const result = await db.query(query, params);

    return res.json({
      success: true,
      count: result.rows.length,
      data: result.rows,
    });
  } catch (error) {
    console.error("Get user results by role error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch user results",
    });
  }
};

// ================= ANALYTICS BY ROLE =================

export const getAnalyticsByRole = async (req, res) => {
  try {
    const roleId = getRoleId(req);
    const userId = getUserId(req);

    const params = [];

    let whereSql = `
      WHERE a.is_deleted = false
      AND aa.status IN ('submitted', 'evaluated')
    `;

    if (roleId === 1) {
      // superadmin sees all
    } else if (roleId === 2) {
      params.push(req.user.company_id);
      whereSql += ` AND u.company_id = $${params.length}`;
    } else if (roleId === 3) {
      params.push(req.user.company_id);
      whereSql += ` AND u.company_id = $${params.length}`;

      params.push(req.user.ship_id);
      whereSql += ` AND u.ship_id = $${params.length}`;
    } else {
      params.push(userId);
      whereSql += ` AND aa.user_id = $${params.length}`;
    }

    const overviewResult = await db.query(
      `
      SELECT
        COUNT(*)::INTEGER AS total_attempts,
        COUNT(DISTINCT aa.user_id)::INTEGER AS total_users,
        COUNT(DISTINCT aa.assessment_id)::INTEGER AS total_assessments,
        AVG(aa.percentage)::NUMERIC(5,2) AS average_percentage,
        MAX(aa.percentage)::NUMERIC(5,2) AS highest_percentage,
        MIN(aa.percentage)::NUMERIC(5,2) AS lowest_percentage,
        COUNT(*) FILTER (WHERE aa.is_passed = true)::INTEGER AS passed_count,
        COUNT(*) FILTER (WHERE aa.is_passed = false)::INTEGER AS failed_count,
        COUNT(*) FILTER (WHERE aa.status = 'submitted')::INTEGER AS pending_review_count
      FROM assessment_attempts aa
      JOIN assessments a ON a.assessment_id = aa.assessment_id
      JOIN users u ON u.user_id = aa.user_id
      ${whereSql}
      `,
      params
    );

    const assessmentBreakdownResult = await db.query(
      `
      SELECT
        a.assessment_id,
        a.title,
        a.assessment_type,
        a.category,
        COUNT(*)::INTEGER AS total_attempts,
        COUNT(DISTINCT aa.user_id)::INTEGER AS unique_users,
        AVG(aa.percentage)::NUMERIC(5,2) AS average_percentage,
        COUNT(*) FILTER (WHERE aa.is_passed = true)::INTEGER AS passed_count,
        COUNT(*) FILTER (WHERE aa.is_passed = false)::INTEGER AS failed_count,
        COUNT(*) FILTER (WHERE aa.status = 'submitted')::INTEGER AS pending_review_count
      FROM assessment_attempts aa
      JOIN assessments a ON a.assessment_id = aa.assessment_id
      JOIN users u ON u.user_id = aa.user_id
      ${whereSql}
      GROUP BY a.assessment_id
      ORDER BY total_attempts DESC
      `,
      params
    );

    const userBreakdownResult = await db.query(
      `
      SELECT
        u.user_id,
        u.full_name,
        u.email,
        u.role_id,
        u.company_id,
        u.ship_id,
        c.company_name,
        s.ship_name,
        COUNT(*)::INTEGER AS total_attempts,
        AVG(aa.percentage)::NUMERIC(5,2) AS average_percentage,
        COUNT(*) FILTER (WHERE aa.is_passed = true)::INTEGER AS passed_count,
        COUNT(*) FILTER (WHERE aa.is_passed = false)::INTEGER AS failed_count,
        COUNT(*) FILTER (WHERE aa.status = 'submitted')::INTEGER AS pending_review_count
      FROM assessment_attempts aa
      JOIN assessments a ON a.assessment_id = aa.assessment_id
      JOIN users u ON u.user_id = aa.user_id
      LEFT JOIN company c ON c.company_id = u.company_id
      LEFT JOIN ships s ON s.ship_id = u.ship_id
      ${whereSql}
      GROUP BY u.user_id, c.company_name, s.ship_name
      ORDER BY total_attempts DESC
      `,
      params
    );

    return res.json({
      success: true,
      data: {
        overview: overviewResult.rows[0],
        assessment_breakdown: assessmentBreakdownResult.rows,
        user_breakdown: userBreakdownResult.rows,
      },
    });
  } catch (error) {
    console.error("Get analytics by role error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch analytics",
    });
  }
};