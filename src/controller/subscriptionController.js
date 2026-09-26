import pool from "../config/db.js";

// =========================================================
// 1. GET SUBSCRIPTION STATUS
// GET /api/subscriptions/status
// =========================================================

export const getSubscriptionStatus = async (req, res) => {
  try {
    const companyId = req.user.company_id;

    if (!companyId) {
      return res.status(400).json({
        message: "Company ID not found",
      });
    }

    const result = await pool.query(
      `
      SELECT
        subscription_id,
        company_id,
        start_date,
        end_date,
        status,
        created_at,
        updated_at,
        notes
      FROM company_subscriptions
      WHERE company_id = $1
      LIMIT 1
      `,
      [companyId]
    );

    // No subscription exists
    if (result.rows.length === 0) {
      return res.status(200).json({
        hasAccess: false,
        status: "not_subscribed",
        subscription: null,
      });
    }

    const subscription = result.rows[0];

    const today = new Date();
    const startDate = new Date(subscription.start_date);
    const endDate = new Date(subscription.end_date);

    // Remove time from today's date
    today.setHours(0, 0, 0, 0);
    startDate.setHours(0, 0, 0, 0);
    endDate.setHours(0, 0, 0, 0);

    let hasAccess = false;
    let currentStatus = subscription.status;

    // Subscription is cancelled
    if (subscription.status === "cancelled") {
      currentStatus = "cancelled";
      hasAccess = false;
    }

    // Subscription has not started
    else if (today < startDate) {
      currentStatus = "not_started";
      hasAccess = false;
    }

    // Subscription has expired
    else if (today > endDate) {
      currentStatus = "expired";
      hasAccess = false;

      // Keep database status synchronized
      if (subscription.status !== "expired") {
        await pool.query(
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
    }

    // Subscription is active
    else {
      currentStatus = "active";
      hasAccess = true;

      // Keep database status synchronized
      if (subscription.status !== "active") {
        await pool.query(
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
    }

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
        notes: subscription.notes,
      },
    });
  } catch (error) {
    console.error("Get subscription status error:", error);

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
    const companyId = req.user.company_id;

    if (!companyId) {
      return res.status(400).json({
        message: "Company ID not found",
      });
    }

    const result = await pool.query(
      `
      SELECT
        subscription_id,
        company_id,
        start_date,
        end_date,
        status,
        created_at,
        updated_at,
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

    const today = new Date();
    const startDate = new Date(subscription.start_date);
    const endDate = new Date(subscription.end_date);

    today.setHours(0, 0, 0, 0);
    startDate.setHours(0, 0, 0, 0);
    endDate.setHours(0, 0, 0, 0);

    let currentStatus = subscription.status;

    if (subscription.status !== "cancelled") {
      if (today < startDate) {
        currentStatus = "not_started";
      } else if (today > endDate) {
        currentStatus = "expired";
      } else {
        currentStatus = "active";
      }
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
    const companyId = req.user.company_id;
    const userId = req.user.user_id;

    if (!companyId) {
      return res.status(400).json({
        message: "Company ID not found",
      });
    }

    // Check for an existing pending request
    const pendingRequest = await pool.query(
      `
      SELECT
        request_id,
        status,
        requested_at
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

    const result = await pool.query(
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
    const companyId = req.user.company_id;

    if (!companyId) {
      return res.status(400).json({
        message: "Company ID not found",
      });
    }

    const result = await pool.query(
      `
      SELECT
        request_id,
        company_id,
        requested_by,
        requested_at,
        status,
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

    const result = await pool.query(query, values);

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

    const result = await pool.query(
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

    return res.status(200).json({
      subscription: result.rows[0],
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

    const superAdminId = req.user.user_id;

    if (!companyId || !startDate || !endDate) {
      return res.status(400).json({
        message:
          "companyId, startDate and endDate are required",
      });
    }

    // Validate dates
    const start = new Date(startDate);
    const end = new Date(endDate);

    if (end < start) {
      return res.status(400).json({
        message: "End date cannot be before start date",
      });
    }

    // Verify company exists
    const companyResult = await pool.query(
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

    // Check if subscription already exists
    const existingSubscription = await pool.query(
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

    const result = await pool.query(
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
  const client = await pool.connect();

  try {
    const { requestId } = req.params;

    const {
      startDate,
      endDate,
      adminNotes,
    } = req.body;

    const superAdminId = req.user.user_id;

    if (!startDate || !endDate) {
      return res.status(400).json({
        message: "Start date and end date are required",
      });
    }

    const start = new Date(startDate);
    const end = new Date(endDate);

    if (end < start) {
      return res.status(400).json({
        message: "End date cannot be before start date",
      });
    }

    await client.query("BEGIN");

    // Get request
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

      return res.status(404).json({
        message: "Subscription request not found",
      });
    }

    const request = requestResult.rows[0];

    if (request.status !== "pending") {
      await client.query("ROLLBACK");

      return res.status(409).json({
        message:
          "This subscription request has already been processed",
      });
    }

    // Check existing subscription
    const existingSubscription = await client.query(
      `
      SELECT subscription_id
      FROM company_subscriptions
      WHERE company_id = $1
      FOR UPDATE
      `,
      [request.company_id]
    );

    let subscription;

    if (existingSubscription.rows.length > 0) {
      // Update existing subscription
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
    } else {
      // Create subscription
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

    // Update request
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

    return res.status(200).json({
      message:
        "Subscription request approved successfully",
      subscription,
    });
  } catch (error) {
    await client.query("ROLLBACK");

    console.error(
      "Approve subscription request error:",
      error
    );

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

    const superAdminId = req.user.user_id;

    const requestResult = await pool.query(
      `
      SELECT
        request_id,
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

    const result = await pool.query(
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

export const updateSubscription = async (
  req,
  res
) => {
  try {
    const { subscriptionId } = req.params;

    const {
      startDate,
      endDate,
      status,
      notes,
    } = req.body;

    const superAdminId = req.user.user_id;

    // Get current subscription
    const existingResult = await pool.query(
      `
      SELECT
        subscription_id,
        company_id,
        start_date,
        end_date,
        status,
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

    const newStartDate =
      startDate || existing.start_date;

    const newEndDate =
      endDate || existing.end_date;

    const newStatus =
      status || existing.status;

    const newNotes =
      notes !== undefined
        ? notes
        : existing.notes;

    // Validate dates
    const start = new Date(newStartDate);
    const end = new Date(newEndDate);

    if (end < start) {
      return res.status(400).json({
        message: "End date cannot be before start date",
      });
    }

    // Validate status
    const allowedStatuses = [
      "active",
      "expired",
      "cancelled",
    ];

    if (!allowedStatuses.includes(newStatus)) {
      return res.status(400).json({
        message:
          "Invalid status. Allowed values: active, expired, cancelled",
      });
    }

    const result = await pool.query(
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

    return res.status(200).json({
      message: "Subscription updated successfully",
      subscription: result.rows[0],
    });
  } catch (error) {
    console.error("Update subscription error:", error);

    return res.status(500).json({
      message: "Failed to update subscription",
      error: error.message,
    });
  }
};