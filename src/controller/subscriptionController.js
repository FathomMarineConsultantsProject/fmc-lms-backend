import { db } from "../db.js";

// =========================================================
// HELPER FUNCTIONS
// =========================================================

const isValidDate = (date) => {
  if (!date || typeof date !== "string") {
    return false;
  }

  // Expected format: YYYY-MM-DD
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return false;
  }

  const parsed = new Date(`${date}T00:00:00Z`);

  return !Number.isNaN(parsed.getTime());
};

const isDateRangeValid = (startDate, endDate) => {
  if (!isValidDate(startDate) || !isValidDate(endDate)) {
    return false;
  }

  return startDate <= endDate;
};

const getSubscriptionStatusFromDates = (
  startDate,
  endDate,
  databaseStatus
) => {
  if (databaseStatus === "cancelled") {
    return "cancelled";
  }

  const today = new Date().toISOString().slice(0, 10);

  if (today < startDate) {
    return "not_started";
  }

  if (today > endDate) {
    return "expired";
  }

  return "active";
};

// =========================================================
// 1. GET SUBSCRIPTION STATUS
// GET /api/subscriptions/status
// =========================================================

export const getSubscriptionStatus = async (req, res) => {
  try {
    const companyId = req.user?.company_id
      ? String(req.user.company_id)
      : null;

    if (!companyId) {
      return res.status(400).json({
        message: "Company ID not found",
      });
    }

    const result = await db.query(
      `
        SELECT
          subscription_id,
          company_id,
          start_date,
          end_date,
          status,
          created_at,
          updated_at,
          created_by,
          notes,

          CASE
            WHEN status = 'cancelled' THEN 'cancelled'
            WHEN CURRENT_DATE < start_date THEN 'not_started'
            WHEN CURRENT_DATE > end_date THEN 'expired'
            ELSE 'active'
          END AS calculated_status

        FROM company_subscriptions
        WHERE company_id = $1
        LIMIT 1
      `,
      [companyId]
    );

    // ---------------------------------------------------------
    // No subscription
    // ---------------------------------------------------------

    if (result.rows.length === 0) {
      return res.status(200).json({
        hasAccess: false,
        status: "not_subscribed",
        subscription: null,
      });
    }

    const subscription = result.rows[0];

    // ---------------------------------------------------------
    // Calculate current subscription status
    // ---------------------------------------------------------

    const currentStatus = subscription.calculated_status;

    const hasAccess = currentStatus === "active";

    // ---------------------------------------------------------
    // Keep database status synchronized
    // ---------------------------------------------------------

    if (
      currentStatus === "expired" &&
      subscription.status !== "expired"
    ) {
      await db.query(
        `
          UPDATE company_subscriptions
          SET
            status = 'expired',
            updated_at = NOW()
          WHERE subscription_id = $1
        `,
        [subscription.subscription_id]
      );
    }

    if (
      currentStatus === "active" &&
      subscription.status === "expired"
    ) {
      await db.query(
        `
          UPDATE company_subscriptions
          SET
            status = 'active',
            updated_at = NOW()
          WHERE subscription_id = $1
        `,
        [subscription.subscription_id]
      );
    }

    // ---------------------------------------------------------
    // Response
    // ---------------------------------------------------------

    return res.status(200).json({
      hasAccess,
      status: currentStatus,

      subscription: {
        subscriptionId: subscription.subscription_id,
        companyId: subscription.company_id,
        startDate: subscription.start_date,
        endDate: subscription.end_date,
        status: currentStatus,
        createdAt: subscription.created_at,
        updatedAt: subscription.updated_at,
        createdBy: subscription.created_by,
        notes: subscription.notes,
      },
    });
  } catch (error) {
    console.error(
      "Get subscription status error:",
      error
    );

    return res.status(500).json({
      message: "Failed to get subscription status",
      error: error.message,
    });
  }
};

// =========================================================
// 2. GET MY SUBSCRIPTION
// GET /api/subscriptions/my
// =========================================================

export const getMySubscription = async (req, res) => {
  try {
    const companyId = req.user?.company_id
      ? String(req.user.company_id)
      : null;

    if (!companyId) {
      return res.status(400).json({
        message: "Company ID not found",
      });
    }

    const result = await db.query(
      `
        SELECT
          subscription_id,
          company_id,
          start_date,
          end_date,
          status,
          created_at,
          updated_at,
          created_by,
          notes
        FROM company_subscriptions
        WHERE company_id = $1
        LIMIT 1
      `,
      [companyId]
    );

    if (result.rows.length === 0) {
      return res.status(200).json({
        subscription: null,
      });
    }

    const subscription = result.rows[0];

    const startDate = String(subscription.start_date).slice(0, 10);
    const endDate = String(subscription.end_date).slice(0, 10);

    const currentStatus = getSubscriptionStatusFromDates(
      startDate,
      endDate,
      subscription.status
    );

    // Keep expired status synchronized
    if (
      currentStatus === "expired" &&
      subscription.status !== "expired"
    ) {
      await db.query(
        `
          UPDATE company_subscriptions
          SET
            status = 'expired',
            updated_at = NOW()
          WHERE subscription_id = $1
        `,
        [subscription.subscription_id]
      );
    }

    return res.status(200).json({
      subscription: {
        subscriptionId: subscription.subscription_id,
        companyId: subscription.company_id,
        startDate: subscription.start_date,
        endDate: subscription.end_date,
        status: currentStatus,
        createdAt: subscription.created_at,
        updatedAt: subscription.updated_at,
        createdBy: subscription.created_by,
        notes: subscription.notes,
      },
    });
  } catch (error) {
    console.error("Get my subscription error:", error);

    return res.status(500).json({
      message: "Failed to get subscription",
      error: error.message,
    });
  }
};

// =========================================================
// 3. REQUEST SUBSCRIPTION / RE-SUBSCRIBE
// POST /api/subscriptions/request
// =========================================================

export const requestSubscription = async (req, res) => {
  try {
    const companyId = req.user?.company_id
      ? String(req.user.company_id)
      : null;

    const userId = req.user?.user_id;

    if (!companyId) {
      return res.status(400).json({
        message: "Company ID not found",
      });
    }

    if (!userId) {
      return res.status(400).json({
        message: "User ID not found",
      });
    }

    // ---------------------------------------------------------
    // Check existing pending request
    // ---------------------------------------------------------

    const pendingRequest = await db.query(
      `
        SELECT
          request_id,
          company_id,
          requested_by,
          requested_at,
          status
        FROM subscription_requests
        WHERE company_id = $1
          AND status = 'pending'
        LIMIT 1
      `,
      [companyId]
    );

    if (pendingRequest.rows.length > 0) {
      return res.status(409).json({
        message: "A subscription request is already pending",
        request: pendingRequest.rows[0],
      });
    }

    // ---------------------------------------------------------
    // Create request
    // ---------------------------------------------------------

    const result = await db.query(
      `
        INSERT INTO subscription_requests (
          company_id,
          requested_by,
          status
        )
        VALUES ($1, $2, 'pending')
        RETURNING
          request_id,
          company_id,
          requested_by,
          requested_at,
          status
      `,
      [companyId, userId]
    );

    return res.status(201).json({
      message: "Subscription renewal request submitted successfully",
      request: result.rows[0],
    });
  } catch (error) {
    console.error("Request subscription error:", error);

    return res.status(500).json({
      message: "Failed to submit subscription request",
      error: error.message,
    });
  }
};

// =========================================================
// 4. GET MY SUBSCRIPTION REQUEST
// GET /api/subscriptions/request
// =========================================================

export const getMySubscriptionRequest = async (req, res) => {
  try {
    const companyId = req.user?.company_id
      ? String(req.user.company_id)
      : null;

    if (!companyId) {
      return res.status(400).json({
        message: "Company ID not found",
      });
    }

    const result = await db.query(
      `
        SELECT
          request_id,
          company_id,
          requested_by,
          requested_at,
          status,
          processed_by,
          processed_at,
          start_date,
          end_date,
          admin_notes
        FROM subscription_requests
        WHERE company_id = $1
        ORDER BY requested_at DESC
        LIMIT 1
      `,
      [companyId]
    );

    if (result.rows.length === 0) {
      return res.status(200).json({
        request: null,
      });
    }

    return res.status(200).json({
      request: result.rows[0],
    });
  } catch (error) {
    console.error("Get my subscription request error:", error);

    return res.status(500).json({
      message: "Failed to get subscription request",
      error: error.message,
    });
  }
};

// =========================================================
// 5. SUPER ADMIN
// GET ALL SUBSCRIPTION REQUESTS
// GET /api/admin/subscriptions/requests
// =========================================================

export const getSubscriptionRequests = async (req, res) => {
  try {
    const { status } = req.query;

    const allowedStatuses = [
      "pending",
      "approved",
      "rejected",
    ];

    if (status && !allowedStatuses.includes(status)) {
      return res.status(400).json({
        message:
          "Invalid status. Allowed values: pending, approved, rejected",
      });
    }

    let query = `
      SELECT
        sr.request_id,
        sr.company_id,
        c.company_name,
        sr.requested_by,
        sr.requested_at,
        sr.status,
        sr.processed_by,
        sr.processed_at,
        sr.start_date,
        sr.end_date,
        sr.admin_notes
      FROM subscription_requests sr
      LEFT JOIN company c
        ON c.company_id = sr.company_id
    `;

    const values = [];

    if (status) {
      query += ` WHERE sr.status = $1`;
      values.push(status);
    }

    query += `
      ORDER BY sr.requested_at DESC
    `;

    const result = await db.query(query, values);

    return res.status(200).json({
      requests: result.rows,
    });
  } catch (error) {
    console.error("Get subscription requests error:", error);

    return res.status(500).json({
      message: "Failed to get subscription requests",
      error: error.message,
    });
  }
};

// =========================================================
// 6. SUPER ADMIN
// GET COMPANY SUBSCRIPTION
// GET /api/admin/subscriptions/company/:companyId
// =========================================================

export const getCompanySubscription = async (req, res) => {
  try {
    const { companyId } = req.params;

    if (!companyId) {
      return res.status(400).json({
        message: "Company ID is required",
      });
    }

    const result = await db.query(
      `
        SELECT
          cs.subscription_id,
          cs.company_id,
          c.company_name,
          cs.start_date,
          cs.end_date,
          cs.status,
          cs.created_at,
          cs.updated_at,
          cs.created_by,
          cs.notes
        FROM company_subscriptions cs
        LEFT JOIN company c
          ON c.company_id = cs.company_id
        WHERE cs.company_id = $1
        LIMIT 1
      `,
      [companyId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        message: "Subscription not found",
      });
    }

    const subscription = result.rows[0];

    const startDate = String(subscription.start_date).slice(0, 10);
    const endDate = String(subscription.end_date).slice(0, 10);

    const currentStatus = getSubscriptionStatusFromDates(
      startDate,
      endDate,
      subscription.status
    );

    return res.status(200).json({
      subscription: {
        ...subscription,
        status: currentStatus,
      },
    });
  } catch (error) {
    console.error("Get company subscription error:", error);

    return res.status(500).json({
      message: "Failed to get company subscription",
      error: error.message,
    });
  }
};

// =========================================================
// 7. SUPER ADMIN
// CREATE SUBSCRIPTION
// POST /api/admin/subscriptions
// =========================================================

export const createSubscription = async (req, res) => {
  try {
    const {
      companyId,
      startDate,
      endDate,
      notes,
    } = req.body;

    const superAdminId = req.user?.user_id;

    if (!companyId || !startDate || !endDate) {
      return res.status(400).json({
        message:
          "companyId, startDate and endDate are required",
      });
    }

    if (!isDateRangeValid(startDate, endDate)) {
      return res.status(400).json({
        message:
          "Invalid dates. Dates must use YYYY-MM-DD format and end date cannot be before start date.",
      });
    }

    // ---------------------------------------------------------
    // Verify company exists
    // ---------------------------------------------------------

    const companyResult = await db.query(
      `
        SELECT company_id
        FROM company
        WHERE company_id = $1
      `,
      [companyId]
    );

    if (companyResult.rows.length === 0) {
      return res.status(404).json({
        message: "Company not found",
      });
    }

    // ---------------------------------------------------------
    // Check existing subscription
    // ---------------------------------------------------------

    const existingSubscription = await db.query(
      `
        SELECT subscription_id
        FROM company_subscriptions
        WHERE company_id = $1
        LIMIT 1
      `,
      [companyId]
    );

    if (existingSubscription.rows.length > 0) {
      return res.status(409).json({
        message:
          "Subscription already exists for this company. Use the update/extend API.",
        subscriptionId:
          existingSubscription.rows[0].subscription_id,
      });
    }

    // ---------------------------------------------------------
    // Create subscription
    // ---------------------------------------------------------

    const result = await db.query(
      `
        INSERT INTO company_subscriptions (
          company_id,
          start_date,
          end_date,
          status,
          created_by,
          notes
        )
        VALUES (
          $1,
          $2,
          $3,
          'active',
          $4,
          $5
        )
        RETURNING
          subscription_id,
          company_id,
          start_date,
          end_date,
          status,
          created_at,
          updated_at,
          created_by,
          notes
      `,
      [
        companyId,
        startDate,
        endDate,
        superAdminId,
        notes || null,
      ]
    );

    return res.status(201).json({
      message: "Subscription created successfully",
      subscription: result.rows[0],
    });
  } catch (error) {
    console.error("Create subscription error:", error);

    // PostgreSQL unique violation
    if (error.code === "23505") {
      return res.status(409).json({
        message:
          "A subscription already exists for this company.",
      });
    }

    return res.status(500).json({
      message: "Failed to create subscription",
      error: error.message,
    });
  }
};

// =========================================================
// 8. SUPER ADMIN
// APPROVE SUBSCRIPTION REQUEST
// POST /api/admin/subscriptions/requests/:requestId/approve
// =========================================================

export const approveSubscriptionRequest = async (
  req,
  res
) => {
  const client = await db.connect();

  let transactionStarted = false;

  try {
    const { requestId } = req.params;

    const {
      startDate,
      endDate,
      adminNotes,
    } = req.body;

    const superAdminId = req.user?.user_id;

    if (!startDate || !endDate) {
      return res.status(400).json({
        message: "Start date and end date are required",
      });
    }

    if (!isDateRangeValid(startDate, endDate)) {
      return res.status(400).json({
        message:
          "Invalid dates. Dates must use YYYY-MM-DD format and end date cannot be before start date.",
      });
    }

    await client.query("BEGIN");
    transactionStarted = true;

    // ---------------------------------------------------------
    // Lock and get request
    // ---------------------------------------------------------

    const requestResult = await client.query(
      `
        SELECT
          request_id,
          company_id,
          status
        FROM subscription_requests
        WHERE request_id = $1
        FOR UPDATE
      `,
      [requestId]
    );

    if (requestResult.rows.length === 0) {
      await client.query("ROLLBACK");
      transactionStarted = false;

      return res.status(404).json({
        message: "Subscription request not found",
      });
    }

    const request = requestResult.rows[0];

    if (request.status !== "pending") {
      await client.query("ROLLBACK");
      transactionStarted = false;

      return res.status(409).json({
        message:
          "This subscription request has already been processed",
      });
    }

    // ---------------------------------------------------------
    // Lock existing subscription
    // ---------------------------------------------------------

    const existingSubscription = await client.query(
      `
        SELECT
          subscription_id
        FROM company_subscriptions
        WHERE company_id = $1
        FOR UPDATE
      `,
      [request.company_id]
    );

    let subscription;

    // ---------------------------------------------------------
    // Update existing subscription
    // ---------------------------------------------------------

    if (existingSubscription.rows.length > 0) {
      const updateResult = await client.query(
        `
          UPDATE company_subscriptions
          SET
            start_date = $1,
            end_date = $2,
            status = 'active',
            updated_at = NOW(),
            created_by = $3,
            notes = $4
          WHERE company_id = $5
          RETURNING
            subscription_id,
            company_id,
            start_date,
            end_date,
            status,
            created_at,
            updated_at,
            created_by,
            notes
        `,
        [
          startDate,
          endDate,
          superAdminId,
          adminNotes || null,
          request.company_id,
        ]
      );

      subscription = updateResult.rows[0];
    }

    // ---------------------------------------------------------
    // Create new subscription
    // ---------------------------------------------------------

    else {
      const insertResult = await client.query(
        `
          INSERT INTO company_subscriptions (
            company_id,
            start_date,
            end_date,
            status,
            created_by,
            notes
          )
          VALUES (
            $1,
            $2,
            $3,
            'active',
            $4,
            $5
          )
          RETURNING
            subscription_id,
            company_id,
            start_date,
            end_date,
            status,
            created_at,
            updated_at,
            created_by,
            notes
        `,
        [
          request.company_id,
          startDate,
          endDate,
          superAdminId,
          adminNotes || null,
        ]
      );

      subscription = insertResult.rows[0];
    }

    // ---------------------------------------------------------
    // Mark request as approved
    // ---------------------------------------------------------

    await client.query(
      `
        UPDATE subscription_requests
        SET
          status = 'approved',
          processed_by = $1,
          processed_at = NOW(),
          start_date = $2,
          end_date = $3,
          admin_notes = $4
        WHERE request_id = $5
      `,
      [
        superAdminId,
        startDate,
        endDate,
        adminNotes || null,
        requestId,
      ]
    );

    await client.query("COMMIT");
    transactionStarted = false;

    return res.status(200).json({
      message:
        "Subscription request approved successfully",
      subscription,
    });
  } catch (error) {
    if (transactionStarted) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        console.error(
          "Rollback error:",
          rollbackError
        );
      }
    }

    console.error(
      "Approve subscription request error:",
      error
    );

    if (error.code === "23505") {
      return res.status(409).json({
        message:
          "A subscription already exists for this company.",
      });
    }

    return res.status(500).json({
      message:
        "Failed to approve subscription request",
      error: error.message,
    });
  } finally {
    client.release();
  }
};

// =========================================================
// 9. SUPER ADMIN
// REJECT SUBSCRIPTION REQUEST
// POST /api/admin/subscriptions/requests/:requestId/reject
// =========================================================

export const rejectSubscriptionRequest = async (
  req,
  res
) => {
  try {
    const { requestId } = req.params;

    const { adminNotes } = req.body;

    const superAdminId = req.user?.user_id;

    // ---------------------------------------------------------
    // Check request
    // ---------------------------------------------------------

    const requestResult = await db.query(
      `
        SELECT
          request_id,
          company_id,
          status
        FROM subscription_requests
        WHERE request_id = $1
      `,
      [requestId]
    );

    if (requestResult.rows.length === 0) {
      return res.status(404).json({
        message: "Subscription request not found",
      });
    }

    if (requestResult.rows[0].status !== "pending") {
      return res.status(409).json({
        message:
          "This subscription request has already been processed",
      });
    }

    // ---------------------------------------------------------
    // Reject request
    // ---------------------------------------------------------

    const result = await db.query(
      `
        UPDATE subscription_requests
        SET
          status = 'rejected',
          processed_by = $1,
          processed_at = NOW(),
          admin_notes = $2
        WHERE request_id = $3
        RETURNING
          request_id,
          company_id,
          status,
          processed_by,
          processed_at,
          admin_notes
      `,
      [
        superAdminId,
        adminNotes || null,
        requestId,
      ]
    );

    return res.status(200).json({
      message:
        "Subscription request rejected successfully",
      request: result.rows[0],
    });
  } catch (error) {
    console.error(
      "Reject subscription request error:",
      error
    );

    return res.status(500).json({
      message:
        "Failed to reject subscription request",
      error: error.message,
    });
  }
};

// =========================================================
// 10. SUPER ADMIN
// UPDATE / EXTEND SUBSCRIPTION
// PUT /api/admin/subscriptions/:subscriptionId
// =========================================================

export const updateSubscription = async (req, res) => {
  try {
    const { subscriptionId } = req.params;

    const {
      action,
      startDate,
      endDate,
      status,
      notes,
    } = req.body;

    const superAdminId = req.user?.user_id;

    // --------------------------------------------------
    // Get existing subscription
    // --------------------------------------------------

    const existingResult = await db.query(
      `
        SELECT
          subscription_id,
          company_id,
          start_date,
          end_date,
          status,
          created_at,
          updated_at,
          created_by,
          notes
        FROM company_subscriptions
        WHERE subscription_id = $1
      `,
      [subscriptionId]
    );

    if (existingResult.rows.length === 0) {
      return res.status(404).json({
        message: "Subscription not found",
      });
    }

    const existing = existingResult.rows[0];

    // --------------------------------------------------
    // Existing dates
    // --------------------------------------------------

    const existingStartDate =
      String(existing.start_date).slice(0, 10);

    const existingEndDate =
      String(existing.end_date).slice(0, 10);

    let newStartDate = existingStartDate;
    let newEndDate = existingEndDate;
    let newStatus = existing.status;

    const newNotes =
      notes !== undefined
        ? notes
        : existing.notes;

    // --------------------------------------------------
    // EXTEND
    // --------------------------------------------------

    if (action === "extend") {
      if (!endDate) {
        return res.status(400).json({
          message:
            "End date is required to extend subscription.",
        });
      }

      newEndDate = String(endDate).slice(0, 10);

      newStatus = "active";
    }

    // --------------------------------------------------
    // STOP
    // --------------------------------------------------

    else if (action === "stop") {
      newStartDate = existingStartDate;
      newEndDate = existingEndDate;

      newStatus = "cancelled";
    }

    // --------------------------------------------------
    // RESUME
    // --------------------------------------------------

    else if (action === "resume") {
      newStartDate =
        startDate
          ? String(startDate).slice(0, 10)
          : existingStartDate;

      newEndDate =
        endDate
          ? String(endDate).slice(0, 10)
          : existingEndDate;

      newStatus = "active";
    }

    // --------------------------------------------------
    // BACKWARD COMPATIBILITY
    // --------------------------------------------------

    else {
      newStartDate =
        startDate
          ? String(startDate).slice(0, 10)
          : existingStartDate;

      newEndDate =
        endDate
          ? String(endDate).slice(0, 10)
          : existingEndDate;

      newStatus =
        status || existing.status;
    }

    // --------------------------------------------------
    // Validate date format
    // --------------------------------------------------

    const dateRegex =
      /^\d{4}-\d{2}-\d{2}$/;

    if (
      !dateRegex.test(newStartDate) ||
      !dateRegex.test(newEndDate)
    ) {
      return res.status(400).json({
        message:
          "Invalid dates. Dates must use YYYY-MM-DD format and end date cannot be before start date.",
      });
    }

    // --------------------------------------------------
    // Validate actual dates
    // --------------------------------------------------

    const start = new Date(
      `${newStartDate}T00:00:00`
    );

    const end = new Date(
      `${newEndDate}T00:00:00`
    );

    if (
      Number.isNaN(start.getTime()) ||
      Number.isNaN(end.getTime())
    ) {
      return res.status(400).json({
        message:
          "Invalid dates. Please provide valid calendar dates.",
      });
    }

    if (end < start) {
      return res.status(400).json({
        message:
          "End date cannot be before start date.",
      });
    }

    // --------------------------------------------------
    // Validate status
    // --------------------------------------------------

    const allowedStatuses = [
      "active",
      "expired",
      "cancelled",
    ];

    if (
      !allowedStatuses.includes(newStatus)
    ) {
      return res.status(400).json({
        message:
          "Invalid status. Allowed values: active, expired, cancelled",
      });
    }

    // --------------------------------------------------
    // Update subscription
    // --------------------------------------------------

    const result = await db.query(
      `
        UPDATE company_subscriptions
        SET
          start_date = $1,
          end_date = $2,
          status = $3,
          updated_at = NOW(),
          created_by = $4,
          notes = $5
        WHERE subscription_id = $6
        RETURNING
          subscription_id,
          company_id,
          start_date,
          end_date,
          status,
          created_at,
          updated_at,
          created_by,
          notes
      `,
      [
        newStartDate,
        newEndDate,
        newStatus,
        superAdminId,
        newNotes,
        subscriptionId,
      ]
    );

    // --------------------------------------------------
    // Response
    // --------------------------------------------------

    return res.status(200).json({
      message:
        action === "extend"
          ? "Subscription extended successfully"
          : action === "stop"
          ? "Subscription stopped successfully"
          : action === "resume"
          ? "Subscription resumed successfully"
          : "Subscription updated successfully",

      subscription: result.rows[0],
    });
  } catch (error) {
    console.error(
      "Update subscription error:",
      error
    );

    return res.status(500).json({
      message:
        "Failed to update subscription",
      error: error.message,
    });
  }
};