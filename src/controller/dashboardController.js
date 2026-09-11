import db from "../db.js";

/* ============================================================
   STATUS HELPERS
   ============================================================ */

/**
 * Current LMS completion state.
 */
function isCompleted(row) {
  return (
    String(row.completion_status || "")
      .trim()
      .toLowerCase() === "completed"
  );
}


/**
 * Whether the enrollment represents an in-progress activity.
 *
 * These are the currently recognized status values.
 * Once you run the status-distribution query against your DB,
 * this can be adjusted to your exact values.
 */
function isInProgress(row) {
  if (isCompleted(row)) {
    return false;
  }

  const status = String(row.enrollment_status || "")
    .trim()
    .toLowerCase();

  return [
    "started",
    "in_progress",
    "in progress",
    "ongoing",
  ].includes(status);
}


/**
 * Whether the enrollment represents a not-started activity.
 */
function isNotStarted(row) {
  if (isCompleted(row) || isInProgress(row)) {
    return false;
  }

  const status = String(row.enrollment_status || "")
    .trim()
    .toLowerCase();

  return [
    "enrolled",
    "assigned",
    "pending",
    "not_started",
    "not started",
  ].includes(status);
}


/**
 * Pending = assigned but not completed.
 *
 * This is intentionally broad because the current schema
 * does not contain a dedicated pending field.
 */
function isPending(row) {
  return !isCompleted(row);
}


/**
 * Overdue cannot currently be calculated.
 *
 * No due_date/deadline field exists in the supplied schema.
 */
function isOverdue() {
  return false;
}


/* ============================================================
   FILTER BUILDER
   ============================================================ */

function buildDashboardFilters(query) {
  const {
    shipId,
    rank,
    department,
    courseId,

    assignedFrom,
    assignedTo,

    joiningFrom,
    joiningTo,

    trainingStatus,
  } = query;

  const conditions = [];
  const params = [];

  let index = 2;

  /* ----------------------------------------------------------
     Vessel
     ---------------------------------------------------------- */

  if (shipId) {
    conditions.push(`u.ship_id = $${index}`);
    params.push(Number(shipId));
    index++;
  }

  /* ----------------------------------------------------------
     Rank
     ---------------------------------------------------------- */

  if (rank) {
    conditions.push(`u.rank = $${index}`);
    params.push(rank);
    index++;
  }

  /* ----------------------------------------------------------
     Department
     ---------------------------------------------------------- */

  if (department) {
    conditions.push(`c.department = $${index}`);
    params.push(department);
    index++;
  }

  /* ----------------------------------------------------------
     Course
     ---------------------------------------------------------- */

  if (courseId) {
    conditions.push(`c.id = $${index}`);
    params.push(Number(courseId));
    index++;
  }

  /* ----------------------------------------------------------
     Assignment date
     ---------------------------------------------------------- */

  if (assignedFrom) {
    conditions.push(`
      ce.enrolled_at >= $${index}
    `);

    params.push(assignedFrom);
    index++;
  }

  if (assignedTo) {
    conditions.push(`
      ce.enrolled_at < ($${index}::date + INTERVAL '1 day')
    `);

    params.push(assignedTo);
    index++;
  }

  /* ----------------------------------------------------------
     Joining / sign-on period
     ---------------------------------------------------------- */

  if (joiningFrom) {
    conditions.push(`
      u.embarkation_date >= $${index}
    `);

    params.push(joiningFrom);
    index++;
  }

  if (joiningTo) {
    conditions.push(`
      u.embarkation_date <= $${index}
    `);

    params.push(joiningTo);
    index++;
  }

  /* ----------------------------------------------------------
     Training status
     ---------------------------------------------------------- */

  if (trainingStatus) {
    const status = trainingStatus
      .trim()
      .toUpperCase();

    switch (status) {
      case "COMPLETED":

        conditions.push(`
          LOWER(COALESCE(ce.completion_status, ''))
          = 'completed'
        `);

        break;

      case "IN_PROGRESS":

        conditions.push(`
          LOWER(COALESCE(ce.completion_status, ''))
          <> 'completed'

          AND LOWER(COALESCE(ce.status, '')) IN (
            'started',
            'in_progress',
            'in progress',
            'ongoing'
          )
        `);

        break;

      case "NOT_STARTED":

        conditions.push(`
          LOWER(COALESCE(ce.completion_status, ''))
          <> 'completed'

          AND LOWER(COALESCE(ce.status, '')) IN (
            'enrolled',
            'assigned',
            'pending',
            'not_started',
            'not started'
          )
        `);

        break;

      case "PENDING":

        conditions.push(`
          LOWER(COALESCE(ce.completion_status, ''))
          <> 'completed'
        `);

        break;

      /*
       * We deliberately don't implement OVERDUE yet.
       */
      case "OVERDUE":

        conditions.push(`
          FALSE
        `);

        break;

      default:
        break;
    }
  }

  return {
    sql:
      conditions.length > 0
        ? `AND ${conditions.join("\nAND ")}`
        : "",

    params,
  };
}



//   GET /api/training/dashboard  

export async function getTrainingDashboard(
  req,
  res
) {
  try {
    const companyId =
      req.user?.company_id;

    if (!companyId) {
      return res.status(400).json({
        success: false,
        message: "Company ID is required",
      });
    }

    const filters =
      buildDashboardFilters(req.query);

    /*
     * --------------------------------------------------------
     * BASE TRAINING DATA
     * --------------------------------------------------------
     *
     * One row represents:
     *
     *      ONE USER
     *          +
     *      ONE ASSIGNED COURSE
     *
     * This is the fundamental reporting grain.
     */

    const query = `
      SELECT

        /* Enrollment */
        ce.id AS enrollment_id,
        ce.user_id,
        ce.course_id,

        ce.status AS enrollment_status,
        ce.completion_status,

        ce.enrolled_at,
        ce.completed_at,

        ce.certificate_issued,

        /* User */
        u.full_name,
        u.seafarer_id,
        u.rank,

        u.status AS user_status,

        u.ship_id,
        u.company_id,

        u.embarkation_date,
        u.disembarkation_date,

        /* Ship */
        s.ship_name,
        s.ship_type,

        /* Course */
        c.title AS course_title,
        c.department AS course_department

      FROM course_enrollments ce

      INNER JOIN users u
        ON u.user_id = ce.user_id

      LEFT JOIN ships s
        ON s.ship_id = u.ship_id

      INNER JOIN courses c
        ON c.id = ce.course_id

      WHERE ce.assigned = true

        AND u.company_id = $1

        AND c.deleted_at IS NULL

        /* Ignore test vessels */
        AND COALESCE(s.is_test_ship, false) = false

        ${filters.sql}

      ORDER BY
        s.ship_name,
        u.rank,
        u.full_name,
        ce.enrolled_at DESC
    `;

    const result = await db.query(
      query,
      [
        companyId,
        ...filters.params,
      ]
    );

    const rows = result.rows;


    /* ========================================================
       SUMMARY
       ======================================================== */

    const trainingAssigned =
      rows.length;

    const trainingCompleted =
      rows.filter(isCompleted).length;

    const trainingInProgress =
      rows.filter(isInProgress).length;

    const trainingNotStarted =
      rows.filter(isNotStarted).length;

    const trainingPending =
      rows.filter(isPending).length;

    /*
     * No deadline exists in supplied schema.
     */
    const trainingOverdue = null;

    const completionPercentage =
      trainingAssigned > 0
        ? Number(
            (
              (trainingCompleted /
                trainingAssigned) *
              100
            ).toFixed(2)
          )
        : 0;


    /* ========================================================
       ACTIVE LEARNERS
       ======================================================== */

    /*
     * We first use recognized active status values.
     *
     * If the actual application uses different status values,
     * update this after checking DISTINCT status values.
     */

    const activeLearnerIds =
      new Set();

    for (const row of rows) {
      const status =
        String(row.user_status || "")
          .trim()
          .toLowerCase();

      if (
        status === "active" ||
        status === "enabled" ||
        status === "1"
      ) {
        activeLearnerIds.add(
          row.user_id
        );
      }
    }

    /*
     * Fallback to assigned unique learners
     * if no recognized active status was found.
     */
    const allLearnerIds =
      new Set(
        rows.map(
          (row) => row.user_id
        )
      );

    const activeLearners =
      activeLearnerIds.size > 0
        ? activeLearnerIds.size
        : allLearnerIds.size;


    /* ========================================================
       BY SHIP
       ======================================================== */

    const shipMap = new Map();

    for (const row of rows) {
      const key =
        row.ship_id ?? "unassigned";

      if (!shipMap.has(key)) {
        shipMap.set(key, {
          ship_id: row.ship_id,

          ship_name:
            row.ship_name ||
            "Unassigned Vessel",

          active_seafarers:
            new Set(),

          training_assigned: 0,
          training_completed: 0,
          training_in_progress: 0,
          training_pending: 0,
          training_not_started: 0,

          last_training_activity_date:
            null,
        });
      }

      const ship =
        shipMap.get(key);

      ship.training_assigned++;

      /*
       * Unique crew members
       */
      ship.active_seafarers.add(
        row.user_id
      );

      if (isCompleted(row)) {
        ship.training_completed++;
      }

      if (isInProgress(row)) {
        ship.training_in_progress++;
      }

      if (isNotStarted(row)) {
        ship.training_not_started++;
      }

      if (isPending(row)) {
        ship.training_pending++;
      }

      /*
       * Last training activity.
       *
       * completed_at is the strongest activity date
       * currently available.
       */
      const activityDate =
        row.completed_at ||
        row.enrolled_at;

      if (activityDate) {
        if (
          !ship.last_training_activity_date ||
          new Date(activityDate) >
            new Date(
              ship.last_training_activity_date
            )
        ) {
          ship.last_training_activity_date =
            activityDate;
        }
      }
    }


    const byShip =
      Array.from(
        shipMap.values()
      ).map((ship) => ({
        ship_id:
          ship.ship_id,

        ship_name:
          ship.ship_name,

        active_seafarers:
          ship.active_seafarers.size,

        training_assigned:
          ship.training_assigned,

        training_completed:
          ship.training_completed,

        training_in_progress:
          ship.training_in_progress,

        training_pending:
          ship.training_pending,

        training_not_started:
          ship.training_not_started,

        training_overdue:
          null,

        completion_percentage:
          ship.training_assigned > 0
            ? Number(
                (
                  (ship.training_completed /
                    ship.training_assigned) *
                  100
                ).toFixed(2)
              )
            : 0,

        last_training_activity_date:
          ship.last_training_activity_date,
      }));


    /* ========================================================
       BY RANK
       ======================================================== */

    const rankMap =
      new Map();

    for (const row of rows) {
      const rank =
        row.rank || "Unknown";

      if (!rankMap.has(rank)) {
        rankMap.set(rank, {
          rank,

          personnel:
            new Set(),

          training_assigned: 0,
          training_completed: 0,
          training_pending: 0,
          training_in_progress: 0,
          training_not_started: 0,
        });
      }

      const rankData =
        rankMap.get(rank);

      rankData.personnel.add(
        row.user_id
      );

      rankData.training_assigned++;

      if (isCompleted(row)) {
        rankData.training_completed++;
      }

      if (isInProgress(row)) {
        rankData.training_in_progress++;
      }

      if (isNotStarted(row)) {
        rankData.training_not_started++;
      }

      if (isPending(row)) {
        rankData.training_pending++;
      }
    }


    const byRank =
      Array.from(
        rankMap.values()
      ).map((rankData) => ({
        rank:
          rankData.rank,

        personnel:
          rankData.personnel.size,

        training_assigned:
          rankData.training_assigned,

        training_completed:
          rankData.training_completed,

        training_pending:
          rankData.training_pending,

        training_in_progress:
          rankData.training_in_progress,

        training_not_started:
          rankData.training_not_started,

        training_overdue:
          null,

        completion_percentage:
          rankData.training_assigned > 0
            ? Number(
                (
                  (rankData.training_completed /
                    rankData.training_assigned) *
                  100
                ).toFixed(2)
              )
            : 0,
      }));


    /* ========================================================
       BY COURSE
       ======================================================== */

    const courseMap =
      new Map();

    for (const row of rows) {
      const courseId =
        row.course_id;

      if (!courseMap.has(courseId)) {
        courseMap.set(courseId, {
          course_id:
            courseId,

          course_title:
            row.course_title,

          department:
            row.course_department,

          assigned: 0,
          completed: 0,
          pending: 0,
          in_progress: 0,
          not_started: 0,
        });
      }

      const course =
        courseMap.get(courseId);

      course.assigned++;

      if (isCompleted(row)) {
        course.completed++;
      }

      if (isInProgress(row)) {
        course.in_progress++;
      }

      if (isNotStarted(row)) {
        course.not_started++;
      }

      if (isPending(row)) {
        course.pending++;
      }
    }


    const byCourse =
      Array.from(
        courseMap.values()
      ).map((course) => ({
        course_id:
          course.course_id,

        course_title:
          course.course_title,

        department:
          course.department,

        assigned:
          course.assigned,

        completed:
          course.completed,

        pending:
          course.pending,

        in_progress:
          course.in_progress,

        not_started:
          course.not_started,

        overdue:
          null,

        completion_percentage:
          course.assigned > 0
            ? Number(
                (
                  (course.completed /
                    course.assigned) *
                  100
                ).toFixed(2)
              )
            : 0,
      }));


    /* ========================================================
       RESPONSE
       ======================================================== */

    return res.status(200).json({
      success: true,

      data: {
        summary: {
          completion_percentage:
            completionPercentage,

          active_learners:
            activeLearners,

          courses_assigned:
            trainingAssigned,

          courses_completed:
            trainingCompleted,

          courses_pending:
            trainingPending,

          courses_in_progress:
            trainingInProgress,

          courses_not_started:
            trainingNotStarted,

          courses_overdue:
            trainingOverdue,
        },

        by_ship:
          byShip,

        by_rank:
          byRank,

        by_course:
          byCourse,

        capabilities: {
          completed: true,
          pending: true,
          in_progress: true,
          not_started: true,

          /*
           * No deadline source exists yet.
           */
          overdue: false,

          /*
           * No fleet entity has been provided.
           */
          fleet: false,
        },
      },
    });
  } catch (error) {
    console.error(
      "getTrainingDashboard error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Failed to load training dashboard",

      error:
        process.env.NODE_ENV ===
        "development"
          ? error.message
          : undefined,
    });
  }
}



//   GET /api/training/dashboard/ships/:shipId


export async function getShipTrainingDashboard(
  req,
  res
) {
  try {
    const companyId =
      req.user?.company_id;

    const { shipId } =
      req.params;

    if (!companyId) {
      return res.status(400).json({
        success: false,
        message: "Company ID is required",
      });
    }

    if (!shipId) {
      return res.status(400).json({
        success: false,
        message: "Ship ID is required",
      });
    }

    const filters =
      buildDashboardFilters(
        req.query
      );


    const query = `
      SELECT

        /* Enrollment */
        ce.id AS enrollment_id,
        ce.user_id,
        ce.course_id,

        ce.status AS enrollment_status,
        ce.completion_status,

        ce.enrolled_at,
        ce.completed_at,

        ce.certificate_issued,

        /* User */
        u.full_name,
        u.seafarer_id,
        u.rank,
        u.status AS user_status,

        u.ship_id,
        u.embarkation_date,
        u.disembarkation_date,

        /* Ship */
        s.ship_name,
        s.ship_type,

        /* Course */
        c.title AS course_title,
        c.department AS course_department

      FROM course_enrollments ce

      INNER JOIN users u
        ON u.user_id = ce.user_id

      INNER JOIN ships s
        ON s.ship_id = u.ship_id

      INNER JOIN courses c
        ON c.id = ce.course_id

      WHERE ce.assigned = true

        AND u.company_id = $1

        AND s.ship_id = $2

        AND COALESCE(s.is_test_ship, false) = false

        AND c.deleted_at IS NULL

        ${filters.sql}

      ORDER BY
        u.rank,
        u.full_name,
        ce.enrolled_at DESC
    `;


    const result =
      await db.query(
        query,
        [
          companyId,
          Number(shipId),
          ...filters.params,
        ]
      );


    const rows =
      result.rows;


    /* ========================================================
       SHIP SUMMARY
       ======================================================== */

    const assigned =
      rows.length;

    const completed =
      rows.filter(
        isCompleted
      ).length;

    const inProgress =
      rows.filter(
        isInProgress
      ).length;

    const pending =
      rows.filter(
        isPending
      ).length;


    /* ========================================================
       CREW
       ======================================================== */

    const crewMap =
      new Map();

    for (const row of rows) {
      if (
        !crewMap.has(
          row.user_id
        )
      ) {
        crewMap.set(
          row.user_id,
          {
            user_id:
              row.user_id,

            seafarer_id:
              row.seafarer_id,

            full_name:
              row.full_name,

            rank:
              row.rank,

            user_status:
              row.user_status,

            embarkation_date:
              row.embarkation_date,

            disembarkation_date:
              row.disembarkation_date,

            training_assigned: 0,

            training_completed: 0,

            training_pending: 0,

            training_in_progress: 0,
          }
        );
      }

      const crew =
        crewMap.get(
          row.user_id
        );

      crew.training_assigned++;

      if (
        isCompleted(row)
      ) {
        crew.training_completed++;
      }

      if (
        isPending(row)
      ) {
        crew.training_pending++;
      }

      if (
        isInProgress(row)
      ) {
        crew.training_in_progress++;
      }
    }


    const crew =
      Array.from(
        crewMap.values()
      ).map((person) => ({
        ...person,

        completion_percentage:
          person.training_assigned > 0
            ? Number(
                (
                  (person.training_completed /
                    person.training_assigned) *
                  100
                ).toFixed(2)
              )
            : 0,
      }));


    /* ========================================================
       RESPONSE
       ======================================================== */

    return res.status(200).json({
      success: true,

      data: {
        ship: {
          ship_id:
            Number(shipId),

          ship_name:
            rows[0]?.ship_name ||
            null,

          ship_type:
            rows[0]?.ship_type ||
            null,
        },

        summary: {
          active_seafarers:
            crew.length,

          training_assigned:
            assigned,

          training_completed:
            completed,

          training_pending:
            pending,

          training_in_progress:
            inProgress,

          training_overdue:
            null,

          completion_percentage:
            assigned > 0
              ? Number(
                  (
                    (completed /
                      assigned) *
                    100
                  ).toFixed(2)
                )
              : 0,
        },

        crew,
      },
    });
  } catch (error) {
    console.error(
      "getShipTrainingDashboard error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Failed to load ship training dashboard",

      error:
        process.env.NODE_ENV ===
        "development"
          ? error.message
          : undefined,
    });
  }
}



   
//GET /api/training/dashboard/users/:userId
  

export async function getSeafarerTrainingDashboard(
  req,
  res
) {
  try {
    const companyId =
      req.user?.company_id;

    const { userId } =
      req.params;

    if (!companyId) {
      return res.status(400).json({
        success: false,
        message: "Company ID is required",
      });
    }

    if (!userId) {
      return res.status(400).json({
        success: false,
        message: "User ID is required",
      });
    }


    const query = `
      SELECT

        /* User */
        u.user_id,
        u.seafarer_id,
        u.full_name,
        u.rank,
        u.status,

        u.embarkation_date,
        u.disembarkation_date,

        /* Ship */
        s.ship_id,
        s.ship_name,
        s.ship_type,

        /* Enrollment */
        ce.id AS enrollment_id,
        ce.course_id,

        ce.status AS enrollment_status,
        ce.completion_status,

        ce.enrolled_at,
        ce.completed_at,

        ce.certificate_issued,

        /* Course */
        c.title AS course_title,
        c.department AS course_department

      FROM users u

      LEFT JOIN ships s
        ON s.ship_id = u.ship_id

      LEFT JOIN course_enrollments ce
        ON ce.user_id = u.user_id
        AND ce.assigned = true

      LEFT JOIN courses c
        ON c.id = ce.course_id
        AND c.deleted_at IS NULL

      WHERE u.user_id = $1

        AND u.company_id = $2

      ORDER BY
        ce.enrolled_at DESC
    `;


    const result =
      await db.query(
        query,
        [
          Number(userId),
          companyId,
        ]
      );


    if (
      result.rows.length === 0
    ) {
      return res.status(404).json({
        success: false,
        message:
          "Seafarer not found",
      });
    }


    const first =
      result.rows[0];


    /* ========================================================
       COURSES
       ======================================================== */

    const courses =
      result.rows
        .filter(
          (row) =>
            row.enrollment_id
        )
        .map((row) => ({
          enrollment_id:
            row.enrollment_id,

          course_id:
            row.course_id,

          title:
            row.course_title,

          department:
            row.course_department,

          status:
            row.enrollment_status,

          completion_status:
            row.completion_status,

          enrolled_at:
            row.enrolled_at,

          completed_at:
            row.completed_at,

          certificate_issued:
            row.certificate_issued,

          overdue:
            null,
        }));


    /* ========================================================
       SUMMARY
       ======================================================== */

    const assigned =
      courses.length;

    const completed =
      courses.filter(
        (course) =>
          String(
            course.completion_status ||
              ""
          )
            .trim()
            .toLowerCase() ===
          "completed"
      ).length;

    const pending =
      assigned - completed;


    /* ========================================================
       RESPONSE
       ======================================================== */

    return res.status(200).json({
      success: true,

      data: {
        seafarer: {
          user_id:
            first.user_id,

          seafarer_id:
            first.seafarer_id,

          full_name:
            first.full_name,

          rank:
            first.rank,

          status:
            first.status,

          ship: {
            ship_id:
              first.ship_id,

            ship_name:
              first.ship_name,

            ship_type:
              first.ship_type,
          },

          embarkation_date:
            first.embarkation_date,

          disembarkation_date:
            first.disembarkation_date,
        },

        summary: {
          courses_assigned:
            assigned,

          courses_completed:
            completed,

          courses_pending:
            pending,

          courses_overdue:
            null,

          completion_percentage:
            assigned > 0
              ? Number(
                  (
                    (completed /
                      assigned) *
                    100
                  ).toFixed(2)
                )
              : 0,
        },

        courses,
      },
    });
  } catch (error) {
    console.error(
      "getSeafarerTrainingDashboard error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Failed to load seafarer training dashboard",

      error:
        process.env.NODE_ENV ===
        "development"
          ? error.message
          : undefined,
    });
  }
}