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

export const awardAIUsageSeaMiles = async (client, userId) => {
  const userResult = await client.query(
    `
    SELECT
      company_id,
      ship_id
    FROM users
    WHERE user_id = $1
    LIMIT 1
    `,
    [userId]
  );

  if (!userResult.rowCount) {
    return;
  }

  const { company_id, ship_id } = userResult.rows[0];

  await client.query(
    `
    INSERT INTO seamiles_ledger (
      user_id,
      company_id,
      ship_id,
      event_type,
      seamiles,
      reference_type,
      metadata
    )
    VALUES (
      $1,
      $2,
      $3,
      'AI_USED',
      -1.00,
      'AI_USAGE',
      $4
    )
    `,
    [
      userId,
      company_id,
      ship_id,
      JSON.stringify({
        action: "chatbot_query"
      })
    ]
  );
};

// =====================================================
// GET CURRENT USER SEAMILES
// =====================================================

export const getMySeaMiles = async (req, res) => {
    try {
        const userId = req.user?.user_id;

        if (!userId) {
            return res.status(401).json({
                success: false,
                message: "User not authenticated",
            });
        }

        const result = await db.query(
            `
            SELECT
                COALESCE(SUM(seamiles), 0) AS total_seamiles
            FROM seamiles_ledger
            WHERE user_id = $1
            `,
            [userId]
        );

        const totalSeaMiles = Number(
            result.rows[0]?.total_seamiles || 0
        );

        return res.status(200).json({
            success: true,
            user_id: userId,
            total_seamiles: totalSeaMiles,
        });

    } catch (error) {
        console.error(
            "getMySeaMiles error:",
            error
        );

        return res.status(500).json({
            success: false,
            message: "Failed to fetch SeaMiles",
            error: error.message,
        });
    }
};