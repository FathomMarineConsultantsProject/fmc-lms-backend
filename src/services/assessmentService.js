import { db } from "../db.js";

export const MCQ_TYPES = ["mcq_single", "mcq_multiple"];
export const ASSESSMENT_TYPES = [...MCQ_TYPES, "subjective"];

export class AssessmentValidationError extends Error {}

const asText = (value, field) => {
  const text = String(value ?? "").trim();
  if (!text) throw new AssessmentValidationError(`${field} is required`);
  return text;
};

const asPositiveNumber = (value, field, fallback = 1) => {
  const number = Number(value ?? fallback);
  if (!Number.isFinite(number) || number <= 0) {
    throw new AssessmentValidationError(`${field} must be greater than 0`);
  }
  return number;
};

const asBoolean = (value, fallback) => typeof value === "boolean" ? value : fallback;

/** Validates and normalizes the public assessment creation contract. */
export function normalizeAssessmentDraft(input = {}) {
  const assessment_type = String(input.assessment_type ?? "").trim();
  if (!ASSESSMENT_TYPES.includes(assessment_type)) {
    throw new AssessmentValidationError("assessment_type must be mcq_single, mcq_multiple or subjective");
  }

  const questions = Array.isArray(input.questions) ? input.questions : [];
  if (!questions.length) throw new AssessmentValidationError("At least one question is required");

  const normalizedQuestions = questions.map((question, index) => {
    const question_type = String(question.question_type ?? assessment_type).trim();
    if (question_type !== assessment_type || !ASSESSMENT_TYPES.includes(question_type)) {
      throw new AssessmentValidationError("All question_type values must match assessment_type");
    }

    const normalized = {
      question_text: asText(question.question_text, `questions[${index}].question_text`),
      question_type,
      marks: asPositiveNumber(question.marks, `questions[${index}].marks`),
      question_order: index + 1,
      explanation: question.explanation ? String(question.explanation).trim() : null,
      is_required: question.is_required !== false,
      options: [],
    };

    const options = Array.isArray(question.options) ? question.options : [];
    if (MCQ_TYPES.includes(assessment_type)) {
      if (options.length < 2) throw new AssessmentValidationError(`questions[${index}] must have at least 2 options`);
      normalized.options = options.map((option, optionIndex) => ({
        option_text: asText(option.option_text, `questions[${index}].options[${optionIndex}].option_text`),
        is_correct: asBoolean(option.is_correct, false),
        option_order: optionIndex + 1,
      }));
      const correctCount = normalized.options.filter((option) => option.is_correct).length;
      if (assessment_type === "mcq_single" && correctCount !== 1) {
        throw new AssessmentValidationError(`questions[${index}] must have exactly one correct option`);
      }
      if (assessment_type === "mcq_multiple" && correctCount < 1) {
        throw new AssessmentValidationError(`questions[${index}] must have at least one correct option`);
      }
    } else if (options.length) {
      throw new AssessmentValidationError("Subjective questions cannot have options");
    }
    return normalized;
  });

  const passing_percentage = Number(input.passing_percentage ?? 0);
  if (!Number.isFinite(passing_percentage) || passing_percentage < 0 || passing_percentage > 100) {
    throw new AssessmentValidationError("passing_percentage must be between 0 and 100");
  }
  const duration_minutes = input.duration_minutes == null || input.duration_minutes === "" ? null : asPositiveNumber(input.duration_minutes, "duration_minutes");

  return {
    title: asText(input.title, "title"),
    description: input.description ? String(input.description).trim() : null,
    assessment_type,
    category: input.category ? String(input.category).trim() : null,
    difficulty_level: input.difficulty_level ? String(input.difficulty_level).trim() : null,
    passing_percentage,
    duration_minutes,
    instructions: input.instructions ? String(input.instructions).trim() : null,
    is_published: asBoolean(input.is_published, false),
    allow_multiple_attempts: asBoolean(input.allow_multiple_attempts, false),
    max_attempts: Math.max(1, Number(input.max_attempts ?? 1) || 1),
    randomize_questions: asBoolean(input.randomize_questions, false),
    show_result_immediately: asBoolean(input.show_result_immediately, true),
    questions: normalizedQuestions,
  };
}

/** Persists a validated assessment using the existing LMS tables. */
export async function createAssessmentRecord({ draft, scope, userId }) {
  const normalized = normalizeAssessmentDraft(draft);
  const courseId = draft.course_id == null || draft.course_id === "" ? null : Number(draft.course_id);
  if (courseId !== null && (!Number.isSafeInteger(courseId) || courseId <= 0)) {
    throw new AssessmentValidationError("course_id must be a valid course id");
  }
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    let linkedCourse = null;
    if (courseId !== null) {
      const courseParams = [courseId];
      let courseSql = "SELECT id, title FROM courses WHERE id = $1 AND deleted_at IS NULL";
      if (scope.company_id != null) {
        courseParams.push(scope.company_id);
        courseSql += ` AND (company_id = $${courseParams.length} OR company_id IS NULL)`;
      }
      if (scope.ship_id != null) {
        courseParams.push(scope.ship_id);
        courseSql += ` AND (ship_id = $${courseParams.length} OR ship_id IS NULL)`;
      }
      const courseResult = await client.query(courseSql, courseParams);
      if (!courseResult.rowCount) throw new AssessmentValidationError("Course not found or not available in your scope");
      linkedCourse = courseResult.rows[0];
    }
    const totalMarks = normalized.questions.reduce((sum, question) => sum + question.marks, 0);
    const assessmentResult = await client.query(`INSERT INTO assessments (
      title, description, assessment_type, category, difficulty_level, passing_percentage,
      duration_minutes, total_marks, instructions, is_published, allow_multiple_attempts,
      max_attempts, randomize_questions, show_result_immediately, company_id, ship_id, created_by, updated_by
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *`, [
      normalized.title, normalized.description, normalized.assessment_type, normalized.category,
      normalized.difficulty_level, normalized.passing_percentage, normalized.duration_minutes, totalMarks,
      normalized.instructions, normalized.is_published, normalized.allow_multiple_attempts,
      normalized.max_attempts, normalized.randomize_questions, normalized.show_result_immediately,
      scope.company_id, scope.ship_id, userId, userId,
    ]);
    const assessment = assessmentResult.rows[0];
    for (const question of normalized.questions) {
      const questionResult = await client.query(`INSERT INTO assessment_questions (
        assessment_id, question_text, question_type, marks, question_order, explanation, is_required
      ) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [
        assessment.assessment_id, question.question_text, question.question_type, question.marks,
        question.question_order, question.explanation, question.is_required,
      ]);
      for (const option of question.options) {
        await client.query(`INSERT INTO assessment_options (question_id, option_text, is_correct, option_order)
          VALUES ($1,$2,$3,$4)`, [questionResult.rows[0].question_id, option.option_text, option.is_correct, option.option_order]);
      }
    }
    if (linkedCourse) {
      await client.query(
        "INSERT INTO course_assessments (course_id, assessment_id) VALUES ($1, $2)",
        [linkedCourse.id, assessment.assessment_id]
      );
    }
    await client.query("COMMIT");
    return { ...assessment, linked_course: linkedCourse };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** Updates metadata, the active question set, and the optional course link together. */
export async function replaceAssessmentRecord({ assessmentId, draft, scope, userId }) {
  const normalized = normalizeAssessmentDraft(draft);
  const courseId = draft.course_id == null || draft.course_id === "" ? null : Number(draft.course_id);
  if (courseId !== null && (!Number.isSafeInteger(courseId) || courseId <= 0)) {
    throw new AssessmentValidationError("course_id must be a valid course id");
  }
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query("SELECT assessment_type FROM assessments WHERE assessment_id = $1 AND is_deleted = false FOR UPDATE", [assessmentId]);
    if (!existing.rowCount) throw new AssessmentValidationError("Assessment not found");
    if (existing.rows[0].assessment_type !== normalized.assessment_type) {
      throw new AssessmentValidationError("Assessment type cannot be changed after creation");
    }
    let linkedCourse = null;
    if (courseId !== null) {
      const params = [courseId];
      let query = "SELECT id, title FROM courses WHERE id = $1 AND deleted_at IS NULL";
      if (scope.company_id != null) { params.push(scope.company_id); query += ` AND (company_id = $${params.length} OR company_id IS NULL)`; }
      if (scope.ship_id != null) { params.push(scope.ship_id); query += ` AND (ship_id = $${params.length} OR ship_id IS NULL)`; }
      const course = await client.query(query, params);
      if (!course.rowCount) throw new AssessmentValidationError("Course not found or not available in your scope");
      linkedCourse = course.rows[0];
    }
    const totalMarks = normalized.questions.reduce((sum, question) => sum + question.marks, 0);
    const updated = await client.query(`UPDATE assessments SET
      title = $2, description = $3, difficulty_level = $4, passing_percentage = $5,
      duration_minutes = $6, instructions = $7, total_marks = $8, is_published = $9,
      updated_by = $10, updated_at = NOW()
      WHERE assessment_id = $1 AND is_deleted = false RETURNING *`, [
      assessmentId, normalized.title, normalized.description, normalized.difficulty_level,
      normalized.passing_percentage, normalized.duration_minutes, normalized.instructions,
      totalMarks, normalized.is_published, userId,
    ]);
    // Keep historical question/option IDs available for submitted attempt records.
    await client.query("UPDATE assessment_questions SET is_deleted = true, updated_at = NOW() WHERE assessment_id = $1 AND is_deleted = false", [assessmentId]);
    for (const question of normalized.questions) {
      const inserted = await client.query(`INSERT INTO assessment_questions
        (assessment_id, question_text, question_type, marks, question_order, explanation, is_required)
        VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING question_id`, [
        assessmentId, question.question_text, question.question_type, question.marks,
        question.question_order, question.explanation, question.is_required,
      ]);
      for (const option of question.options) {
        await client.query(`INSERT INTO assessment_options (question_id, option_text, is_correct, option_order)
          VALUES ($1,$2,$3,$4)`, [inserted.rows[0].question_id, option.option_text, option.is_correct, option.option_order]);
      }
    }
    await client.query("DELETE FROM course_assessments WHERE assessment_id = $1", [assessmentId]);
    if (linkedCourse) await client.query("INSERT INTO course_assessments (course_id, assessment_id) VALUES ($1,$2)", [linkedCourse.id, assessmentId]);
    await client.query("COMMIT");
    return { ...updated.rows[0], linked_course: linkedCourse };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}
