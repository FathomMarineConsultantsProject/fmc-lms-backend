import { db } from "../db.js";

const isAdminRole = (roleId) => [1, 2, 3].includes(Number(roleId));

const getUserId = (req) => req.user?.user_id || req.user?.id;
const getRoleId = (req) => Number(req.user?.role_id);

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
        company_id || req.user?.company_id || null,
        ship_id || req.user?.ship_id || null,
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

    if (roleId === 2) {
      params.push(user.company_id);
      query += ` AND a.company_id = $${params.length}`;
    }

    if (roleId === 3) {
      params.push(user.company_id);
      query += ` AND a.company_id = $${params.length}`;

      params.push(user.ship_id);
      query += ` AND (a.ship_id = $${params.length} OR a.ship_id IS NULL)`;
    }

    if (roleId === 4) {
      params.push(user.company_id);
      query += ` AND a.company_id = $${params.length}`;

      params.push(user.ship_id);
      query += ` AND (a.ship_id = $${params.length} OR a.ship_id IS NULL)`;

      query += ` AND a.is_published = true`;
    }

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

    const assessmentResult = await db.query(
      `
      SELECT *
      FROM assessments
      WHERE assessment_id = $1
      AND is_deleted = false
      `,
      [assessmentId]
    );

    if (assessmentResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Assessment not found",
      });
    }

    const assessment = assessmentResult.rows[0];

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

    const result = await db.query(
      `
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
        show_result_immediately = COALESCE($12, show_result_immediately),
        company_id = COALESCE($13, company_id),
        ship_id = COALESCE($14, ship_id),
        updated_by = $15,
        updated_at = NOW()
      WHERE assessment_id = $16
      AND is_deleted = false
      RETURNING *
      `,
      [
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
        company_id ?? null,
        ship_id ?? null,
        userId,
        assessmentId,
      ]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Assessment not found",
      });
    }

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

// ================= DELETE ASSESSMENT =================

export const deleteAssessment = async (req, res) => {
  try {
    const { assessmentId } = req.params;
    const userId = getUserId(req);

    const result = await db.query(
      `
      UPDATE assessments
      SET is_deleted = true,
          updated_by = $1,
          updated_at = NOW()
      WHERE assessment_id = $2
      AND is_deleted = false
      RETURNING assessment_id
      `,
      [userId, assessmentId]
    );

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

// ================= START ASSESSMENT =================

export const startAssessment = async (req, res) => {
  try {
    const { assessmentId } = req.params;
    const userId = getUserId(req);

    const assessmentResult = await db.query(
      `
      SELECT *
      FROM assessments
      WHERE assessment_id = $1
      AND is_deleted = false
      AND is_published = true
      `,
      [assessmentId]
    );

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
          answer_text,
          is_correct,
          marks_awarded
        )
        VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT (attempt_id, question_id)
        DO UPDATE SET
          selected_option_id = EXCLUDED.selected_option_id,
          answer_text = EXCLUDED.answer_text,
          is_correct = EXCLUDED.is_correct,
          marks_awarded = EXCLUDED.marks_awarded,
          answered_at = NOW()
        `,
        [
          attempt_id,
          question.question_id,
          selectedOptionId,
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
        opt.option_text AS selected_option_text
      FROM assessment_answers ans
      JOIN assessment_questions q ON q.question_id = ans.question_id
      LEFT JOIN assessment_options opt ON opt.option_id = ans.selected_option_id
      WHERE ans.attempt_id = $1
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

    const result = await db.query(
      `
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
      ORDER BY aa.created_at DESC
      `,
      [userId]
    );

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