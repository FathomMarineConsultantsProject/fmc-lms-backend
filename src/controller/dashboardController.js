import { db } from "../db.js";


/* ============================================================
   STATUS HELPERS
   ============================================================ */

/**
 * Completed
 *
 * Current LMS completion state is determined from
 * course_enrollments.completion_status.
 */
function isCompleted(row) {
  return (
    String(row.completion_status || "")
      .trim()
      .toLowerCase() === "completed"
  );
}


/**
 * In Progress
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
 * Not Started
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
 * Pending
 */
function isPending(row) {
  return (
    !isCompleted(row) &&
    !isInProgress(row) &&
    !isNotStarted(row)
  );
}


/**
 * Overdue
 *
 * Currently unavailable because the LMS schema
 * does not contain a due_date/deadline field.
 */
function isOverdue() {
  return false;
}


/* ============================================================
   ACCESS CONTROL / COMPANY SCOPE
   ============================================================ */

/**
 * Determines the company scope for the authenticated user.
 *
 * ROLE 1 = Super Admin
 * --------------------------------
 * - Has no company_id.
 * - Can access all companies.
 * - Can optionally filter by ?companyId=<UUID>.
 *
 * ROLE 2 = Admin
 * --------------------------------
 * - Must have company_id.
 * - Can ONLY access their own company.
 * - Any companyId supplied through query params is ignored.
 */
function getCompanyScope(req) {
  const roleId = Number(req.user?.role_id);
  const userCompanyId = req.user?.company_id;
  const requestedCompanyId = req.query?.companyId;

  /* ----------------------------------------------------------
     SUPER ADMIN
     ---------------------------------------------------------- */

  if (roleId === 1) {
    return {
      roleId,
      companyId: requestedCompanyId || null,
      companyScoped: Boolean(requestedCompanyId),
      allCompanies: !requestedCompanyId,
    };
  }


  /* ----------------------------------------------------------
     ADMIN
     ---------------------------------------------------------- */

  if (roleId === 2) {
    if (!userCompanyId) {
      return {
        error: true,
        status: 403,
        message:
          "Admin is not associated with a company",
      };
    }

    return {
      roleId,
      companyId: userCompanyId,
      companyScoped: true,
      allCompanies: false,
    };
  }


  /* ----------------------------------------------------------
     OTHER ROLES
     ---------------------------------------------------------- */

  return {
    error: true,
    status: 403,
    message:
      "You are not authorized to access this dashboard",
  };
}


/* ============================================================
   FILTER BUILDER
   ============================================================ */

/**
 * Builds optional dashboard filters.
 *
 * startIndex:
 *   PostgreSQL parameter number from which filters start.
 *
 * Example:
 *
 * buildDashboardFilters(query, 1)
 *   shipId -> $1
 *
 * buildDashboardFilters(query, 2)
 *   shipId -> $2
 */
function buildDashboardFilters(
  query,
  startIndex = 1
) {
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

  let index = startIndex;


  /* ----------------------------------------------------------
     SHIP
     ---------------------------------------------------------- */

  if (shipId) {
    conditions.push(
      `u.ship_id = $${index}`
    );

    params.push(Number(shipId));
    index++;
  }


  /* ----------------------------------------------------------
     RANK
     ---------------------------------------------------------- */

  if (rank) {
    conditions.push(
      `u.rank = $${index}`
    );

    params.push(rank);
    index++;
  }


  /* ----------------------------------------------------------
     DEPARTMENT
     ---------------------------------------------------------- */

  if (department) {
    conditions.push(
      `c.department = $${index}`
    );

    params.push(department);
    index++;
  }


  /* ----------------------------------------------------------
     COURSE
     ---------------------------------------------------------- */

  if (courseId) {
    conditions.push(
      `c.id = $${index}`
    );

    params.push(Number(courseId));
    index++;
  }


  /* ----------------------------------------------------------
     ASSIGNMENT DATE
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
      ce.enrolled_at <
      ($${index}::date + INTERVAL '1 day')
    `);

    params.push(assignedTo);
    index++;
  }


  /* ----------------------------------------------------------
     JOINING / SIGN-ON PERIOD
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
     TRAINING STATUS
     ---------------------------------------------------------- */

  if (trainingStatus) {
    const status = trainingStatus
      .trim()
      .toUpperCase();


    switch (status) {

      /* ------------------------------------------------------
         COMPLETED
         ------------------------------------------------------ */

      case "COMPLETED":

        conditions.push(`
          LOWER(
            COALESCE(
              ce.completion_status,
              ''
            )
          ) = 'completed'
        `);

        break;


      /* ------------------------------------------------------
         IN PROGRESS
         ------------------------------------------------------ */

      case "IN_PROGRESS":

        conditions.push(`
          LOWER(
            COALESCE(
              ce.completion_status,
              ''
            )
          ) <> 'completed'

          AND LOWER(
            COALESCE(
              ce.status,
              ''
            )
          ) IN (
            'started',
            'in_progress',
            'in progress',
            'ongoing'
          )
        `);

        break;


      /* ------------------------------------------------------
         NOT STARTED
         ------------------------------------------------------ */

      case "NOT_STARTED":

        conditions.push(`
          LOWER(
            COALESCE(
              ce.completion_status,
              ''
            )
          ) <> 'completed'

          AND LOWER(
            COALESCE(
              ce.status,
              ''
            )
          ) IN (
            'enrolled',
            'assigned',
            'pending',
            'not_started',
            'not started'
          )
        `);

        break;


      /* ------------------------------------------------------
         PENDING
         ------------------------------------------------------ */

      case "PENDING":

        conditions.push(`
          LOWER(
            COALESCE(
              ce.completion_status,
              ''
            )
          ) <> 'completed'

          AND LOWER(
            COALESCE(
              ce.status,
              ''
            )
          ) NOT IN (
            'started',
            'in_progress',
            'in progress',
            'ongoing',
            'enrolled',
            'assigned',
            'pending',
            'not_started',
            'not started'
          )
        `);

        break;


      /* ------------------------------------------------------
         OVERDUE
         ------------------------------------------------------ */

      case "OVERDUE":

        /*
         * No due_date/deadline field currently exists.
         */
        conditions.push(`FALSE`);

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


/* ============================================================
   API 1
   GET /api/training/dashboard
   ============================================================ */

/**
 * Main Training Dashboard
 *
 * Super Admin:
 *   GET /dashboard
 *   -> All companies
 *
 *   GET /dashboard?companyId=<UUID>
 *   -> Selected company
 *
 * Admin:
 *   GET /dashboard
 *   -> Own company only
 *
 *   GET /dashboard?companyId=<OTHER_UUID>
 *   -> Still own company
 */
export async function getTrainingDashboard(
  req,
  res
) {
  try {

    /* ========================================================
       ACCESS / COMPANY SCOPE
       ======================================================== */

    const scope = getCompanyScope(req);

    if (scope.error) {
      return res.status(scope.status).json({
        success: false,
        message: scope.message,
      });
    }

    const {
      companyId,
      allCompanies,
    } = scope;


    /* ========================================================
       BASE CONDITIONS
       ======================================================== */

    const baseConditions = [
      `ce.assigned = true`,
      `c.deleted_at IS NULL`,
      `COALESCE(
        s.is_test_ship,
        false
      ) = false`,
    ];

    const baseParams = [];

    let filterStartIndex = 1;


    /* ========================================================
       COMPANY FILTER
       ======================================================== */

    if (companyId) {
      baseConditions.push(
        `u.company_id = $${filterStartIndex}`
      );

      baseParams.push(companyId);

      filterStartIndex++;
    }


    /* ========================================================
       OTHER FILTERS
       ======================================================== */

    const filters =
      buildDashboardFilters(
        req.query,
        filterStartIndex
      );


    /* ========================================================
       BASE TRAINING DATA
       
       Reporting grain:

       ONE USER
       +
       ONE ASSIGNED COURSE
       ======================================================== */

    const query = `
      SELECT

        /* ====================================================
           ENROLLMENT
           ==================================================== */

        ce.id AS enrollment_id,

        ce.user_id,

        ce.course_id,

        ce.status AS enrollment_status,

        ce.completion_status,

        ce.enrolled_at,

        ce.completed_at,

        ce.certificate_issued,


        /* ====================================================
           USER
           ==================================================== */

        u.full_name,

        u.seafarer_id,

        u.rank,

        u.status AS user_status,

        u.ship_id,

        u.company_id,

        u.embarkation_date,

        u.disembarkation_date,


        /* ====================================================
           COMPANY
           ==================================================== */

        comp.company_name,


        /* ====================================================
           SHIP
           ==================================================== */

        s.ship_name,

        s.ship_type,


        /* ====================================================
           COURSE
           ==================================================== */

        c.title AS course_title,

        c.department AS course_department


      FROM course_enrollments ce


      INNER JOIN users u
        ON u.user_id = ce.user_id


      LEFT JOIN company comp
        ON comp.company_id = u.company_id


      LEFT JOIN ships s
        ON s.ship_id = u.ship_id


      INNER JOIN courses c
        ON c.id = ce.course_id


      WHERE ${baseConditions.join("\nAND ")}

        ${filters.sql}


      ORDER BY
        comp.company_name,
        s.ship_name,
        u.rank,
        u.full_name,
        ce.enrolled_at DESC
    `;


    const result = await db.query(
      query,
      [
        ...baseParams,
        ...filters.params,
      ]
    );


    const rows = result.rows;


    /* ========================================================
       OVERALL SUMMARY
       ======================================================== */

    const trainingAssigned =
      rows.length;


    const trainingCompleted =
      rows.filter(
        isCompleted
      ).length;


    const trainingInProgress =
      rows.filter(
        isInProgress
      ).length;


    const trainingNotStarted =
      rows.filter(
        isNotStarted
      ).length;


    const trainingPending =
      rows.filter(
        isPending
      ).length;


    const trainingOverdue =
      isOverdue()
        ? rows.filter(
            isOverdue
          ).length
        : null;


    const completionPercentage =
      trainingAssigned > 0
        ? Number(
            (
              (
                trainingCompleted /
                trainingAssigned
              ) * 100
            ).toFixed(2)
          )
        : 0;


    /* ========================================================
       ACTIVE LEARNERS
       ======================================================== */

    const activeLearnerIds =
      new Set();


    for (const row of rows) {

      const status =
        String(
          row.user_status || ""
        )
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


    const allLearnerIds =
      new Set(
        rows.map(
          (row) =>
            row.user_id
        )
      );


    const activeLearners =
      activeLearnerIds.size > 0
        ? activeLearnerIds.size
        : allLearnerIds.size;


    /* ========================================================
       BY COMPANY
       ======================================================== */

    const companyMap =
      new Map();


    for (const row of rows) {

      const key =
        row.company_id ??
        "unassigned";


      if (!companyMap.has(key)) {

        companyMap.set(
          key,
          {
            company_id:
              row.company_id,

            company_name:
              row.company_name ||
              "Unassigned Company",

            assigned: 0,

            completed: 0,

            in_progress: 0,

            not_started: 0,

            pending: 0,
          }
        );
      }


      const company =
        companyMap.get(key);


      company.assigned++;


      if (
        isCompleted(row)
      ) {
        company.completed++;
      }


      if (
        isInProgress(row)
      ) {
        company.in_progress++;
      }


      if (
        isNotStarted(row)
      ) {
        company.not_started++;
      }


      if (
        isPending(row)
      ) {
        company.pending++;
      }
    }


    const byCompany =
      Array.from(
        companyMap.values()
      )
        .map(
          (company) => ({
            company_id:
              company.company_id,

            company_name:
              company.company_name,

            assigned:
              company.assigned,

            completed:
              company.completed,

            in_progress:
              company.in_progress,

            not_started:
              company.not_started,

            pending:
              company.pending,

            completion_percentage:
              company.assigned > 0
                ? Number(
                    (
                      (
                        company.completed /
                        company.assigned
                      ) * 100
                    ).toFixed(2)
                  )
                : 0,
          })
        )
        .sort(
          (a, b) =>
            a.completion_percentage -
            b.completion_percentage
        );


    /* ========================================================
       BY SHIP
       ======================================================== */

    const shipMap =
      new Map();


    for (const row of rows) {

      const key =
        row.ship_id ??
        "unassigned";


      if (!shipMap.has(key)) {

        shipMap.set(
          key,
          {
            ship_id:
              row.ship_id,

            ship_name:
              row.ship_name ||
              "Unassigned Vessel",

            ship_type:
              row.ship_type ||
              null,

            active_seafarers:
              new Set(),

            training_assigned:
              0,

            training_completed:
              0,

            training_in_progress:
              0,

            training_pending:
              0,

            training_not_started:
              0,

            last_training_activity_date:
              null,
          }
        );
      }


      const ship =
        shipMap.get(key);


      ship.training_assigned++;


      ship.active_seafarers.add(
        row.user_id
      );


      if (
        isCompleted(row)
      ) {
        ship.training_completed++;
      }


      if (
        isInProgress(row)
      ) {
        ship.training_in_progress++;
      }


      if (
        isNotStarted(row)
      ) {
        ship.training_not_started++;
      }


      if (
        isPending(row)
      ) {
        ship.training_pending++;
      }


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
      )
        .map(
          (ship) => ({
            ship_id:
              ship.ship_id,

            ship_name:
              ship.ship_name,

            ship_type:
              ship.ship_type,

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
                      (
                        ship.training_completed /
                        ship.training_assigned
                      ) * 100
                    ).toFixed(2)
                  )
                : 0,

            last_training_activity_date:
              ship.last_training_activity_date,
          })
        )
        .sort(
          (a, b) =>
            a.completion_percentage -
            b.completion_percentage
        );


    /* ========================================================
       BY RANK
       ======================================================== */

    const rankMap =
      new Map();


    for (const row of rows) {

      const rank =
        row.rank ||
        "Unknown";


      if (!rankMap.has(rank)) {

        rankMap.set(
          rank,
          {
            rank,

            personnel:
              new Set(),

            training_assigned:
              0,

            training_completed:
              0,

            training_pending:
              0,

            training_in_progress:
              0,

            training_not_started:
              0,
          }
        );
      }


      const rankData =
        rankMap.get(rank);


      rankData.personnel.add(
        row.user_id
      );


      rankData.training_assigned++;


      if (
        isCompleted(row)
      ) {
        rankData.training_completed++;
      }


      if (
        isInProgress(row)
      ) {
        rankData.training_in_progress++;
      }


      if (
        isNotStarted(row)
      ) {
        rankData.training_not_started++;
      }


      if (
        isPending(row)
      ) {
        rankData.training_pending++;
      }
    }


    const byRank =
      Array.from(
        rankMap.values()
      )
        .map(
          (rankData) => ({
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
                      (
                        rankData.training_completed /
                        rankData.training_assigned
                      ) * 100
                    ).toFixed(2)
                  )
                : 0,
          })
        )
        .sort(
          (a, b) =>
            a.completion_percentage -
            b.completion_percentage
        );


    /* ========================================================
       RESPONSE
       ======================================================== */

    return res.status(200).json({

      success: true,

      data: {

        scope: {

          company_id:
            companyId || null,

          all_companies:
            allCompanies,
        },


        /* ==================================================
           KPI
           ================================================== */

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


        /* ==================================================
           DASHBOARD BREAKDOWNS
           ================================================== */

        by_company:
          byCompany,

        by_ship:
          byShip,

        by_rank:
          byRank,


        /* ==================================================
           CAPABILITIES
           ================================================== */

        capabilities: {

          completed:
            true,

          pending:
            true,

          in_progress:
            true,

          not_started:
            true,

          overdue:
            false,

          fleet:
            false,
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


/* ============================================================
   API 2
   GET /api/training/dashboard/ships/:shipId
   ============================================================ */

/**
 * Ship Training Dashboard
 *
 * Super Admin:
 *   Can access any ship.
 *
 * Admin:
 *   Can access only ships belonging
 *   to their company.
 */
export async function getShipTrainingDashboard(
  req,
  res
) {

  try {

    const {
      shipId,
    } = req.params;


    /* ========================================================
       VALIDATE SHIP ID
       ======================================================== */

    if (!shipId) {

      return res.status(400).json({

        success: false,

        message:
          "Ship ID is required",
      });
    }


    /* ========================================================
       ACCESS / COMPANY SCOPE
       ======================================================== */

    const scope =
      getCompanyScope(req);


    if (scope.error) {

      return res.status(
        scope.status
      ).json({

        success: false,

        message:
          scope.message,
      });
    }


    const {
      companyId,
      companyScoped,
    } = scope;


    /* ========================================================
       DASHBOARD FILTERS
       ======================================================== */

    /*
     * $1 = shipId
     *
     * If Admin:
     *   $2 = companyId
     *   optional filters start at $3
     *
     * If Super Admin:
     *   optional filters start at $2
     */

    const filterStartIndex =
      companyScoped
        ? 3
        : 2;


    const filters =
      buildDashboardFilters(
        req.query,
        filterStartIndex
      );


    /* ========================================================
       BASE CONDITIONS
       ======================================================== */

    const baseConditions = [

      `ce.assigned = true`,

      `s.ship_id = $1`,

      `COALESCE(
        s.is_test_ship,
        false
      ) = false`,

      `c.deleted_at IS NULL`,
    ];


    /* ========================================================
       ADMIN COMPANY RESTRICTION
       ======================================================== */

    if (companyScoped) {

      baseConditions.push(
        `s.company_id = $2`
      );
    }


    /* ========================================================
       QUERY
       ======================================================== */

    const query = `

      SELECT

        /* ====================================================
           ENROLLMENT
           ==================================================== */

        ce.id AS enrollment_id,

        ce.user_id,

        ce.course_id,

        ce.status AS enrollment_status,

        ce.completion_status,

        ce.enrolled_at,

        ce.completed_at,

        ce.certificate_issued,


        /* ====================================================
           USER
           ==================================================== */

        u.full_name,

        u.seafarer_id,

        u.rank,

        u.status AS user_status,

        u.ship_id,

        u.company_id,

        u.embarkation_date,

        u.disembarkation_date,


        /* ====================================================
           SHIP
           ==================================================== */

        s.ship_name,

        s.ship_type,


        /* ====================================================
           COURSE
           ==================================================== */

        c.title AS course_title,

        c.department AS course_department


      FROM course_enrollments ce


      INNER JOIN users u
        ON u.user_id = ce.user_id


      INNER JOIN ships s
        ON s.ship_id = u.ship_id


      INNER JOIN courses c
        ON c.id = ce.course_id


      WHERE
        ${baseConditions.join("\nAND ")}

        ${filters.sql}


      ORDER BY
        u.rank,
        u.full_name,
        ce.enrolled_at DESC
    `;


    /* ========================================================
       PARAMETERS
       ======================================================== */

    const queryParams = [

      Number(shipId),

      ...(companyScoped
        ? [companyId]
        : []),

      ...filters.params,
    ];


    const result =
      await db.query(
        query,
        queryParams
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


    const notStarted =
      rows.filter(
        isNotStarted
      ).length;


    const pending =
      rows.filter(
        isPending
      ).length;


    const completionPercentage =
      assigned > 0
        ? Number(
            (
              (
                completed /
                assigned
              ) * 100
            ).toFixed(2)
          )
        : 0;


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

            training_assigned:
              0,

            training_completed:
              0,

            training_pending:
              0,

            training_in_progress:
              0,

            training_not_started:
              0,
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
        isInProgress(row)
      ) {

        crew.training_in_progress++;
      }


      if (
        isNotStarted(row)
      ) {

        crew.training_not_started++;
      }


      if (
        isPending(row)
      ) {

        crew.training_pending++;
      }
    }


    const crew =
      Array.from(
        crewMap.values()
      )
        .map(
          (person) => ({

            ...person,

            completion_percentage:
              person.training_assigned > 0
                ? Number(
                    (
                      (
                        person.training_completed /
                        person.training_assigned
                      ) * 100
                    ).toFixed(2)
                  )
                : 0,
          })
        );


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

          company_id:
            rows[0]?.company_id ||
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

          training_not_started:
            notStarted,

          training_overdue:
            null,

          completion_percentage:
            completionPercentage,
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


/* ============================================================
   API 3
   GET /api/training/dashboard/users/:userId
   ============================================================ */

/**
 * Individual Seafarer Training Details
 *
 * Super Admin:
 *   Can access any seafarer.
 *
 * Admin:
 *   Can access only seafarers
 *   belonging to their company.
 */
export async function getSeafarerTrainingDashboard(
  req,
  res
) {

  try {

    const {
      userId,
    } = req.params;


    /* ========================================================
       VALIDATE USER ID
       ======================================================== */

    if (!userId) {

      return res.status(400).json({

        success: false,

        message:
          "User ID is required",
      });
    }


    /* ========================================================
       ACCESS / COMPANY SCOPE
       ======================================================== */

    const scope =
      getCompanyScope(req);


    if (scope.error) {

      return res.status(
        scope.status
      ).json({

        success: false,

        message:
          scope.message,
      });
    }


    const {
      companyId,
      companyScoped,
    } = scope;


    /* ========================================================
       QUERY
       ======================================================== */

    const query = `

      SELECT

        /* ====================================================
           USER
           ==================================================== */

        u.user_id,

        u.seafarer_id,

        u.full_name,

        u.rank,

        u.status,

        u.company_id,

        u.embarkation_date,

        u.disembarkation_date,


        /* ====================================================
           COMPANY
           ==================================================== */

        comp.company_name,


        /* ====================================================
           SHIP
           ==================================================== */

        s.ship_id,

        s.ship_name,

        s.ship_type,


        /* ====================================================
           ENROLLMENT
           ==================================================== */

        ce.id AS enrollment_id,

        ce.course_id,

        ce.status AS enrollment_status,

        ce.completion_status,

        ce.enrolled_at,

        ce.completed_at,

        ce.certificate_issued,


        /* ====================================================
           COURSE
           ==================================================== */

        c.title AS course_title,

        c.department AS course_department


      FROM users u


      /* ======================================================
         COMPANY
         ====================================================== */

      LEFT JOIN company comp
        ON comp.company_id =
           u.company_id


      /* ======================================================
         SHIP
         ====================================================== */

      LEFT JOIN ships s
        ON s.ship_id =
           u.ship_id


      /* ======================================================
         ASSIGNED COURSES
         ====================================================== */

      LEFT JOIN course_enrollments ce
        ON ce.user_id =
           u.user_id

        AND ce.assigned = true


      /* ======================================================
         COURSE
         ====================================================== */

      LEFT JOIN courses c
        ON c.id =
           ce.course_id

        AND c.deleted_at IS NULL


      /* ======================================================
         USER FILTER
         ====================================================== */

      WHERE u.user_id = $1

        ${
          companyScoped
            ? `AND u.company_id = $2`
            : ""
        }


      ORDER BY
        ce.enrolled_at DESC
    `;


    /* ========================================================
       PARAMETERS
       ======================================================== */

    const queryParams = [

      Number(userId),

      ...(companyScoped
        ? [companyId]
        : []),
    ];


    const result =
      await db.query(
        query,
        queryParams
      );


    /* ========================================================
       SEAFARER NOT FOUND
       ======================================================== */

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

        .map(
          (row) => ({

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

            /*
             * No due_date/deadline exists
             * in the current LMS schema.
             */
            overdue:
              null,
          })
        );


    /* ========================================================
       TRAINING SUMMARY
       ======================================================== */

    const assigned =
      courses.length;


    /* --------------------------------------------------------
       COMPLETED
       -------------------------------------------------------- */

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


    /* --------------------------------------------------------
       IN PROGRESS
       -------------------------------------------------------- */

    const inProgress =
      courses.filter(
        (course) => {

          const completionStatus =
            String(
              course.completion_status ||
              ""
            )
              .trim()
              .toLowerCase();


          if (
            completionStatus ===
            "completed"
          ) {
            return false;
          }


          const status =
            String(
              course.status ||
              ""
            )
              .trim()
              .toLowerCase();


          return [
            "started",
            "in_progress",
            "in progress",
            "ongoing",
          ].includes(status);
        }
      ).length;


    /* --------------------------------------------------------
       NOT STARTED
       -------------------------------------------------------- */

    const notStarted =
      courses.filter(
        (course) => {

          const completionStatus =
            String(
              course.completion_status ||
              ""
            )
              .trim()
              .toLowerCase();


          if (
            completionStatus ===
            "completed"
          ) {
            return false;
          }


          const status =
            String(
              course.status ||
              ""
            )
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
      ).length;


    /* --------------------------------------------------------
       PENDING
       -------------------------------------------------------- */

    /*
     * Keep the existing controller's behavior:
     * anything that is not completed is considered pending.
     */
    const pending =
      assigned -
      completed;


    /* --------------------------------------------------------
       COMPLETION %
       -------------------------------------------------------- */

    const completionPercentage =
      assigned > 0
        ? Number(
            (
              (
                completed /
                assigned
              ) * 100
            ).toFixed(2)
          )
        : 0;


    /* ========================================================
       RESPONSE
       ======================================================== */

    return res.status(200).json({

      success: true,

      data: {

        /* ====================================================
           SEAFARER
           ==================================================== */

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


          /* --------------------------------------------------
             COMPANY
             -------------------------------------------------- */

          company: {

            company_id:
              first.company_id,

            company_name:
              first.company_name ||
              null,
          },


          /* --------------------------------------------------
             SHIP
             -------------------------------------------------- */

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


        /* ====================================================
           TRAINING SUMMARY
           ==================================================== */

        summary: {

          courses_assigned:
            assigned,

          courses_completed:
            completed,

          courses_in_progress:
            inProgress,

          courses_not_started:
            notStarted,

          courses_pending:
            pending,

          /*
           * No deadline field exists,
           * therefore overdue cannot currently
           * be calculated.
           */
          courses_overdue:
            null,

          completion_percentage:
            completionPercentage,
        },


        /* ====================================================
           ASSIGNED COURSES
           ==================================================== */

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