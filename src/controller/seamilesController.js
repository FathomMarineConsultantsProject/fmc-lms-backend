import { db } from "../db.js";

// ======================================================
// SEAMILES CONTROLLER
// ======================================================

// +0.5 SeaMiles when training/course is completed
export const awardTrainingSeaMiles = async (
  client,
  userId,
  courseId
) => {
  const result = await client.query(
    `
    SELECT
      c.company_id,
      c.ship_id
    FROM courses c
    INNER JOIN course_completion_history cch
      ON cch.course_id = c.id
    WHERE cch.user_id = $1
      AND cch.course_id = $2
      AND c.deleted_at IS NULL
    LIMIT 1
    `,
    [userId, courseId]
  );

  if (!result.rowCount) {
    return;
  }

  const { company_id, ship_id } = result.rows[0];

  await client.query(
    `
    INSERT INTO seamiles_ledger (
      user_id,
      company_id,
      ship_id,
      event_type,
      seamiles,
      reference_id,
      reference_type
    )
    VALUES (
      $1,
      $2,
      $3,
      'TRAINING_COMPLETED',
      0.50,
      $4,
      'COURSE'
    )
    ON CONFLICT DO NOTHING
    `,
    [
      userId,
      company_id,
      ship_id,
      String(courseId),
    ]
  );
};


// +0.5 SeaMiles when linked assessment is passed
export const awardAssessmentSeaMiles = async (
  client,
  userId,
  assessmentId
) => {
  // Get assessment + linked training
  const assessmentResult = await client.query(
    `
    SELECT
      a.assessment_id,
      a.training_id,
      a.company_id,
      a.ship_id
    FROM assessments a
    WHERE a.assessment_id = $1
      AND COALESCE(a.is_deleted, false) = false
    LIMIT 1
    `,
    [assessmentId]
  );

  if (!assessmentResult.rowCount) {
    return;
  }

  const assessment = assessmentResult.rows[0];

  // Standalone assessment = NO SeaMiles
  if (!assessment.training_id) {
    return;
  }

  // Training must be completed
  const completionResult = await client.query(
    `
    SELECT 1
    FROM course_completion_history
    WHERE user_id = $1
      AND course_id = $2
    LIMIT 1
    `,
    [userId, assessment.training_id]
  );

  if (!completionResult.rowCount) {
    return;
  }

  await client.query(
    `
    INSERT INTO seamiles_ledger (
      user_id,
      company_id,
      ship_id,
      event_type,
      seamiles,
      reference_id,
      reference_type
    )
    VALUES (
      $1,
      $2,
      $3,
      'ASSESSMENT_PASSED',
      0.50,
      $4,
      'ASSESSMENT'
    )
    ON CONFLICT DO NOTHING
    `,
    [
      userId,
      assessment.company_id,
      assessment.ship_id,
      String(assessmentId),
    ]
  );
};


// +1 SeaMile when certificate is generated
export const awardCertificateSeaMiles = async (
  client,
  userId,
  certificateId
) => {
  const certificateResult = await client.query(
    `
    SELECT
      certificate_id,
      company_id,
      ship_id,
      course_id,
      assessment_id,
      issue_date
    FROM certificates
    WHERE certificate_id = $1
      AND user_id = $2
    LIMIT 1
    `,
    [
      certificateId,
      userId,
    ]
  );

  if (!certificateResult.rowCount) {
    return;
  }

  const certificate = certificateResult.rows[0];

  // Certificate must actually be issued
  if (!certificate.issue_date) {
    return;
  }

  await client.query(
    `
    INSERT INTO seamiles_ledger (
      user_id,
      company_id,
      ship_id,
      event_type,
      seamiles,
      reference_id,
      reference_type,
      metadata
    )
    VALUES (
      $1,
      $2,
      $3,
      'CERTIFICATE_ISSUED',
      1.00,
      $4,
      'CERTIFICATE',
      $5
    )
    ON CONFLICT DO NOTHING
    `,
    [
      userId,
      certificate.company_id,
      certificate.ship_id,
      String(certificateId),
      JSON.stringify({
        course_id: certificate.course_id,
        assessment_id: certificate.assessment_id,
      }),
    ]
  );
};