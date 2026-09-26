// A completion-only enrollment can be created by the legacy completion endpoint.
// Timestamps and status cannot prove earlier enrollment (a second completion
// would make the timestamps look legitimate), so require assignment provenance.
export const genuineEnrollment = (alias = 'ce') => `(
  ${alias}.assigned = true OR ${alias}.enrolled_by IS NOT NULL
)`;

export async function getLinkedAssessmentAccess(client, assessmentId, user) {
  const result = await client.query(`
    SELECT ca.course_id, ce.completion_status,
      (${genuineEnrollment()}) AS entitled,
      (c.id IS NOT NULL AND ($3::int = 1 OR c.company_id = $4 OR c.company_id IS NULL)) AS company_allowed,
      ($3::int NOT IN (3,4) OR c.ship_id = $5 OR c.ship_id IS NULL) AS ship_allowed
    FROM course_assessments ca
    LEFT JOIN courses c ON c.id = ca.course_id AND c.deleted_at IS NULL
    LEFT JOIN course_enrollments ce ON ce.course_id = c.id AND ce.user_id = $2
    WHERE ca.assessment_id = $1
  `, [assessmentId, user.user_id || user.id, Number(user.role_id), user.company_id || null, user.ship_id || null]);
  return result.rows[0] || null;
}
