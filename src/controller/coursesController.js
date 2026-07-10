import { db } from "../db.js";
import crypto from "crypto";
import { PutObjectCommand, DeleteObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { s3, S3_BUCKET, AWS_REGION, SIGNED_URL_EXPIRES } from "../config/s3.js";

const VALID_CONTENT_MODES = new Set(["single_training", "course"]);
const VALID_CONTENT_TYPES = new Set([
  "youtube",
  "document",
  "video_file",
  "image",
  "ppt",
]);

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

async function checkCourseScope(req, courseId, client = db, options = {}) {
  const params = [courseId];

  let query = `
    SELECT c.id
    FROM courses c
    WHERE c.id = $1
      AND c.deleted_at IS NULL
  `;

  query += addScopeWhere(req, "c", params, options);

  const result = await client.query(query, params);
  return result.rowCount > 0;
}
const getAuthUserId = (req) => req.user?.user_id ?? req.user?.id ?? null;

const normalizeString = (value) => {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  return s ? s : null;
};

function validateCoursePayload(body, isUpdate = false) {
  const errors = [];

  const title = normalizeString(body.title);
  const description = normalizeString(body.description);
  const department = normalizeString(body.department);
  const predefined_course_title = normalizeString(body.predefined_course_title);

  const ranks = Array.isArray(body.ranks) ? body.ranks : [];
  const ship_types = Array.isArray(body.ship_types) ? body.ship_types : [];

  const content_mode = isUpdate
    ? (body.content_mode !== undefined ? normalizeString(body.content_mode) : undefined)
    : (normalizeString(body.content_mode) || "course");

  const contents = Array.isArray(body.contents) ? body.contents : [];

  if (!isUpdate || body.title !== undefined) {
    if (!title) errors.push("title is required");
  }

  if (!isUpdate || body.department !== undefined) {
    if (!department) errors.push("department is required");
  }

  if (body.content_mode !== undefined) {
    if (!content_mode || !VALID_CONTENT_MODES.has(content_mode)) {
      errors.push("content_mode must be single_training or course");
    }
  }

  if (!isUpdate || body.contents !== undefined) {
    if (!Array.isArray(contents) || contents.length === 0) {
      errors.push("contents must be a non-empty array");
    }
  }

  if (Array.isArray(contents) && body.contents !== undefined) {
    if (content_mode === "single_training" && contents.length > 1) {
      errors.push("single_training can only have 1 content item");
    }

    contents.forEach((item, index) => {
      const content_title = normalizeString(item.content_title);
      const content_type = normalizeString(item.content_type);
      const youtube_url = normalizeString(item.youtube_url);
      const sort_order = item.sort_order ?? index + 1;

      if (!content_title) {
        errors.push(`contents[${index}].content_title is required`);
      }

      if (!content_type || !VALID_CONTENT_TYPES.has(content_type)) {
        errors.push(
          `contents[${index}].content_type must be one of youtube, document, video_file, image, ppt`
        );
      }

      if (content_type === "youtube" && !youtube_url) {
        errors.push(`contents[${index}].youtube_url is required for youtube content`);
      }

      if (content_type !== "youtube" && youtube_url) {
        errors.push(`contents[${index}].youtube_url is only allowed for youtube content`);
      }

      if (!Number.isInteger(Number(sort_order)) || Number(sort_order) < 1) {
        errors.push(`contents[${index}].sort_order must be a positive integer`);
      }
    });
  }

  return {
    errors,
    payload: {
      title,
      description,
      department,
      predefined_course_title,
      content_mode,
      contents,
      ranks,
      ship_types
    },
  };
}

async function fetchCourseWithContents(courseId) {
  const courseResult = await db.query(
    `
      SELECT
  c.id,
  c.title,
  c.description,
  c.department,
  c.predefined_course_title,
  c.status,
  c.content_mode,
  c.certificate_prefix,
  c.company_id,
  c.ship_id,
  c.ranks,
  c.ship_types,
  c.created_by,
  c.updated_by,
  c.created_at,
  c.updated_at,
  c.deleted_at
      FROM courses c
      WHERE c.id = $1
        AND c.deleted_at IS NULL
    `,
    [courseId]
  );

  if (!courseResult.rowCount) return null;

  const contentsResult = await db.query(
    `
      SELECT
        cc.id,
        cc.course_id,
        cc.content_title,
        cc.content_description,
        cc.content_type,
        cc.youtube_url,
        cc.sort_order,
        cc.created_at,
        cc.updated_at
      FROM course_contents cc
      WHERE cc.course_id = $1
      ORDER BY cc.sort_order ASC, cc.id ASC
    `,
    [courseId]
  );

  const contents = contentsResult.rows;

  if (!contents.length) {
    return {
      ...courseResult.rows[0],
      contents: [],
    };
  }

  const contentIds = contents.map((c) => c.id);

  const mediaResult = await db.query(
    `
      SELECT
        ccm.course_content_id,
        mf.id AS media_file_id,
        mf.original_file_name,
        mf.stored_file_name,
        mf.file_type,
        mf.mime_type,
        mf.file_size_bytes,
        mf.storage_provider,
        mf.upload_status,
        mf.created_at AS media_created_at,
        ms3.bucket_name,
        ms3.object_key,
        ms3.file_url,
        ms3.region
      FROM course_content_media ccm
      JOIN media_files mf
        ON mf.id = ccm.media_file_id
      LEFT JOIN media_storage_s3 ms3
        ON ms3.media_file_id = mf.id
      WHERE ccm.course_content_id = ANY($1::bigint[])
      ORDER BY mf.id ASC
    `,
    [contentIds]
  );

  const mediaByContentId = new Map();

  for (const row of mediaResult.rows) {
    if (!mediaByContentId.has(row.course_content_id)) {
      mediaByContentId.set(row.course_content_id, []);
    }
    mediaByContentId.get(row.course_content_id).push(row);
  }

  return {
    ...courseResult.rows[0],
    contents: contents.map((content) => ({
      ...content,
      media: mediaByContentId.get(content.id) || [],
    })),
  };
}

function sanitizeFileName(name = "") {
  return String(name).replace(/[^a-zA-Z0-9._-]/g, "_");
}

function buildStoredFileName(originalName) {
  return `${crypto.randomUUID()}-${sanitizeFileName(originalName)}`;
}

function generateCertificatePrefix(title) {
  if (!title) return null;

  // remove spaces & special chars
  let clean = String(title)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");

  // if less than 4 chars → pad with X
  if (clean.length < 4) {
    return clean.padEnd(4, "X");
  }

  // otherwise take first 4 chars
  return clean.slice(0, 4);
}

function getFileTypeFromMime(mimeType) {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video_file";

  if (
    mimeType === "application/vnd.ms-powerpoint" ||
    mimeType === "application/vnd.openxmlformats-officedocument.presentationml.presentation"
  ) {
    return "ppt";
  }

  if (
    mimeType === "application/pdf" ||
    mimeType === "application/msword" ||
    mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  ) {
    return "document";
  }

  return null;
}

function addMonths(dateInput, months) {
  const date = new Date(dateInput);
  const d = new Date(date);
  d.setMonth(d.getMonth() + months);
  return d;
}

function toDateOnlyString(dateInput) {
  const date = new Date(dateInput);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export async function createCourse(req, res) {
  const client = await db.connect();

  try {
    const { errors, payload } = validateCoursePayload(req.body, false);

    if (errors.length) {
      return res.status(400).json({
        message: "Validation failed",
        errors,
      });
    }

    const authUserId = getAuthUserId(req);
    const scope = getCreateScope(req);

    await client.query("BEGIN");

    const prefixSource = payload.predefined_course_title || payload.title;
    const certificatePrefix = generateCertificatePrefix(prefixSource);

    const courseInsert = await client.query(
      `
INSERT INTO courses (
  title,
  description,
  department,
  predefined_course_title,
  status,
  content_mode,
  certificate_prefix,
  company_id,
  ship_id,
  created_by,
  updated_by,
  ranks,
  ship_types
)
VALUES ($1, $2, $3, $4, 'draft', $5, $6, $7, $8, $9, $9, $10, $11)
RETURNING
  id,
  title,
  description,
  department,
  predefined_course_title,
  status,
  content_mode,
  certificate_prefix,
  company_id,
  ship_id,
  created_by,
  updated_by,
  created_at,
  updated_at,
  deleted_at
`,
      [
        payload.title,
        payload.description,
        payload.department,
        payload.predefined_course_title,
        payload.content_mode,
        certificatePrefix,
        scope.company_id,
        scope.ship_id,
        authUserId,
        payload.ranks,
        payload.ship_types
      ]
    );

    const course = courseInsert.rows[0];

    const certificateIssueInsert = await client.query(
      `
  INSERT INTO certificate_issues (
    source_type,
    course_id,
    assessment_id,
    certificate_name,
    certificate_description,
    notes,
    issuing_authority,
    issue_date,
    expiry_date,
    issued_by_user_id,
    issued_by_name_snapshot,
    company_id,
    ship_id,
    created_at,
    updated_at
  )
  VALUES (
  'course',
  $1,
  NULL,
  $2,
  $3,
  NULL,
  'Fathom Marine Consultants',
  NOW(),
  $4,
  $5,
  NULL,
  $6,
  $7,
  NOW(),
  NOW()
    )
  RETURNING *
  `,
      [
        course.id,
        course.title,
        course.description,
        toDateOnlyString(addMonths(new Date(), 3)),
        authUserId,
        scope.company_id,
        scope.ship_id,
      ]
    );

    const insertedContents = [];

    for (let i = 0; i < payload.contents.length; i++) {
      const item = payload.contents[i];

      const contentInsert = await client.query(
        `
          INSERT INTO course_contents (
            course_id,
            content_title,
            content_description,
            content_type,
            youtube_url,
            sort_order
          )
          VALUES ($1, $2, $3, $4, $5, $6)
          RETURNING
            id,
            course_id,
            content_title,
            content_description,
            content_type,
            youtube_url,
            sort_order,
            created_at,
            updated_at
        `,
        [
          course.id,
          normalizeString(item.content_title),
          normalizeString(item.content_description),
          normalizeString(item.content_type),
          normalizeString(item.youtube_url),
          Number(item.sort_order ?? i + 1),
        ]
      );

      insertedContents.push(contentInsert.rows[0]);
    }

    await client.query("COMMIT");

    return res.status(201).json({
      message: "Course created successfully",
      course: {
        ...course,
        contents: insertedContents,
      },
      certificate_issue: certificateIssueInsert.rows[0],
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("createCourse error:", error);
    return res.status(500).json({
      message: "Failed to create course",
      error: error.message,
    });
  } finally {
    client.release();
  }
}

export async function getCourses(req, res) {
  try {
    const params = [];

    let query = `
      SELECT
        c.id,
        c.title,
        c.description,
        c.department,
        c.predefined_course_title,
        c.status,
        c.content_mode,
        c.certificate_prefix,
        c.company_id,
        c.ship_id,
        c.ranks,
        c.ship_types,
        c.created_by,
        c.updated_by,
        c.created_at,
        c.updated_at,
        COUNT(cc.id)::int AS contents_count
      FROM courses c
      LEFT JOIN course_contents cc
        ON cc.course_id = c.id
      WHERE c.deleted_at IS NULL
    `;

    query += addScopeWhere(req, "c", params, { includeGlobal: true });

    query += `
      GROUP BY c.id
      ORDER BY c.created_at DESC
    `;

    const result = await db.query(query, params);

    return res.json({
      message: "Courses fetched successfully",
      courses: result.rows,
    });
  } catch (error) {
    console.error("getCourses error:", error);
    return res.status(500).json({
      message: "Failed to fetch courses",
      error: error.message,
    });
  }
}

export async function getCourseById(req, res) {
  try {
    const courseId = Number(req.params.id);

    if (!courseId || Number.isNaN(courseId)) {
      return res.status(400).json({ message: "Invalid course id" });
    }

    const params = [courseId];

    let checkQuery = `
      SELECT c.id
      FROM courses c
      WHERE c.id = $1
        AND c.deleted_at IS NULL
    `;

    checkQuery += addScopeWhere(req, "c", params, { includeGlobal: true });

    const check = await db.query(checkQuery, params);

    if (!check.rowCount) {
      return res.status(404).json({ message: "Course not found" });
    }

    const course = await fetchCourseWithContents(courseId);

    return res.json({
      message: "Course fetched successfully",
      course,
    });
  } catch (error) {
    console.error("getCourseById error:", error);
    return res.status(500).json({
      message: "Failed to fetch course",
      error: error.message,
    });
  }
}

export async function getCoursesByUserId(req, res) {
  try {
    const { userId } = req.params;

    const params = [userId];

    let query = `
      SELECT
        c.id,
        c.title,
        c.description,
        c.department,
        c.predefined_course_title,
        c.status,
        c.content_mode,
        c.certificate_prefix,
        c.ranks,
        c.ship_types,
        ce.status AS enrollment_status,
        ce.enrolled_at,
        COUNT(cc.id)::int AS contents_count
      FROM course_enrollments ce
      JOIN courses c
        ON c.id = ce.course_id
      LEFT JOIN course_contents cc
        ON cc.course_id = c.id
      WHERE ce.user_id = $1
        AND c.deleted_at IS NULL
    `;

    query += addScopeWhere(req, "c", params, { includeGlobal: true });

    query += `
      GROUP BY
        c.id,
        ce.status,
        ce.enrolled_at
      ORDER BY ce.enrolled_at DESC
    `;

    const result = await db.query(query, params);

    return res.json({
      message: "Enrolled courses fetched successfully",
      courses: result.rows,
    });
  } catch (error) {
    console.error("getCoursesByUserId error:", error);
    return res.status(500).json({
      message: "Failed to fetch enrolled courses",
      error: error.message,
    });
  }
}

export async function updateCourse(req, res) {
  const client = await db.connect();

  try {
    const courseId = Number(req.params.id);

    if (!courseId || Number.isNaN(courseId)) {
      return res.status(400).json({ message: "Invalid course id" });
    }

    const checkParams = [courseId];

    let checkQuery = `
      SELECT c.id
      FROM courses c
      WHERE c.id = $1
        AND c.deleted_at IS NULL
    `;

    checkQuery += addScopeWhere(req, "c", checkParams);

    const existingCourse = await client.query(checkQuery, checkParams);

    if (!existingCourse.rowCount) {
      return res.status(404).json({ message: "Course not found" });
    }

    const { errors, payload } = validateCoursePayload(req.body, true);

    if (errors.length) {
      return res.status(400).json({
        message: "Validation failed",
        errors,
      });
    }

    const authUserId = getAuthUserId(req);

    await client.query("BEGIN");

    const bodyHasPredefinedCourseTitle =
      Object.prototype.hasOwnProperty.call(req.body, "predefined_course_title");

    await client.query(
      `
      UPDATE courses
      SET
        title = COALESCE($1, title),
        description = COALESCE($2, description),
        department = COALESCE($3, department),
        predefined_course_title = CASE
          WHEN $4::boolean THEN $5
          ELSE predefined_course_title
        END,
        content_mode = COALESCE($6, content_mode),
        updated_by = $7,
        updated_at = CURRENT_TIMESTAMP,
        ranks = COALESCE($9, ranks),
        ship_types = COALESCE($10, ship_types)
      WHERE id = $8
      `,
      [
        payload.title,
        payload.description,
        payload.department,
        bodyHasPredefinedCourseTitle,
        payload.predefined_course_title,
        payload.content_mode,
        authUserId,
        courseId,
        payload.ranks,
        payload.ship_types
      ]
    );

    if (Array.isArray(req.body.contents)) {
      await client.query(`DELETE FROM course_contents WHERE course_id = $1`, [courseId]);

      for (let i = 0; i < payload.contents.length; i++) {
        const item = payload.contents[i];

        await client.query(
          `
          INSERT INTO course_contents (
            course_id,
            content_title,
            content_description,
            content_type,
            youtube_url,
            sort_order
          )
          VALUES ($1, $2, $3, $4, $5, $6)
          `,
          [
            courseId,
            normalizeString(item.content_title),
            normalizeString(item.content_description),
            normalizeString(item.content_type),
            normalizeString(item.youtube_url),
            Number(item.sort_order ?? i + 1),
          ]
        );
      }
    }

    await client.query("COMMIT");

    const course = await fetchCourseWithContents(courseId);

    return res.json({
      message: "Course updated successfully",
      course,
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("updateCourse error:", error);
    return res.status(500).json({
      message: "Failed to update course",
      error: error.message,
    });
  } finally {
    client.release();
  }
}

export async function deleteCourse(req, res) {
  try {
    const courseId = Number(req.params.id);

    if (!courseId || Number.isNaN(courseId)) {
      return res.status(400).json({ message: "Invalid course id" });
    }

    const params = [courseId];

    let query = `
      UPDATE courses c
      SET deleted_at = CURRENT_TIMESTAMP
      WHERE c.id = $1
        AND c.deleted_at IS NULL
    `;

    query += addScopeWhere(req, "c", params);

    query += `
      RETURNING c.id
    `;

    const result = await db.query(query, params);

    if (!result.rowCount) {
      return res.status(404).json({
        message: "Course not found or already deleted",
      });
    }

    return res.json({
      message: "Course deleted successfully",
    });
  } catch (error) {
    console.error("deleteCourse error:", error);
    return res.status(500).json({
      message: "Failed to delete course",
      error: error.message,
    });
  }
}

export async function uploadCourseContentMedia(req, res) {
  const client = await db.connect();
  let transactionStarted = false;
  try {
    const courseId = Number(req.params.courseId);
    const contentId = Number(req.params.contentId);
    const authUserId = getAuthUserId(req);
    const files = req.files || [];

    const MAX_TOTAL_CONTENT_MEDIA_SIZE = 5 * 1024 * 1024; // 5 MB total per content

    if (!S3_BUCKET) {
      return res.status(500).json({
        message: "S3 bucket is not configured",
      });
    }

    if (!courseId || Number.isNaN(courseId)) {
      return res.status(400).json({ message: "Invalid course id" });
    }

    if (!contentId || Number.isNaN(contentId)) {
      return res.status(400).json({ message: "Invalid content id" });
    }

    if (!files.length) {
      return res.status(400).json({ message: "At least one file is required" });
    }

    const allowed = await checkCourseScope(req, courseId, client);

    if (!allowed) {
      return res.status(404).json({ message: "Course not found" });
    }

    const contentResult = await client.query(
      `
        SELECT
          cc.id,
          cc.course_id,
          cc.content_type,
          c.deleted_at
        FROM course_contents cc
        JOIN courses c
          ON c.id = cc.course_id
        WHERE cc.id = $1
          AND cc.course_id = $2
          AND c.deleted_at IS NULL
        LIMIT 1
      `,
      [contentId, courseId]
    );

    if (!contentResult.rowCount) {
      return res.status(404).json({ message: "Course content not found" });
    }

    const content = contentResult.rows[0];

    if (content.content_type === "youtube") {
      return res.status(400).json({
        message: "YouTube content does not accept file upload",
      });
    }

    for (const file of files) {
      const fileType = getFileTypeFromMime(file.mimetype);

      if (!fileType) {
        return res.status(400).json({
          message: `Unsupported file type: ${file.mimetype}`,
        });
      }

      if (content.content_type !== fileType) {
        return res.status(400).json({
          message: `Uploaded file type (${fileType}) does not match content type (${content.content_type})`,
        });
      }
    }

    const existingSizeResult = await client.query(
      `
        SELECT COALESCE(SUM(mf.file_size_bytes), 0)::bigint AS total_size
        FROM course_content_media ccm
        JOIN media_files mf
          ON mf.id = ccm.media_file_id
        WHERE ccm.course_content_id = $1
      `,
      [contentId]
    );

    const existingTotalSize = Number(existingSizeResult.rows[0]?.total_size || 0);
    const newFilesTotalSize = files.reduce((sum, file) => sum + Number(file.size || 0), 0);

    if (existingTotalSize + newFilesTotalSize > MAX_TOTAL_CONTENT_MEDIA_SIZE) {
      return res.status(400).json({
        message: "Total upload size limit exceeded for this content",
        max_allowed_bytes: MAX_TOTAL_CONTENT_MEDIA_SIZE,
        existing_total_bytes: existingTotalSize,
        new_files_total_bytes: newFilesTotalSize,
        remaining_bytes: Math.max(0, MAX_TOTAL_CONTENT_MEDIA_SIZE - existingTotalSize),
      });
    }

    await client.query("BEGIN");
    transactionStarted = true;

    const uploadedMedia = [];

    for (const file of files) {
      const fileType = getFileTypeFromMime(file.mimetype);
      const storedFileName = buildStoredFileName(file.originalname);
      const s3Key = `courses/${courseId}/contents/${contentId}/${storedFileName}`;

      await s3.send(
        new PutObjectCommand({
          Bucket: S3_BUCKET,
          Key: s3Key,
          Body: file.buffer,
          ContentType: file.mimetype,
        })
      );

      const publicUrl = `https://${S3_BUCKET}.s3.${AWS_REGION}.amazonaws.com/${s3Key
        .split("/")
        .map(encodeURIComponent)
        .join("/")}`;

      const mediaInsert = await client.query(
        `
          INSERT INTO media_files (
            original_file_name,
            stored_file_name,
            file_type,
            mime_type,
            file_size_bytes,
            storage_provider,
            local_path,
            uploaded_by,
            upload_status
          )
          VALUES ($1, $2, $3, $4, $5, 's3', NULL, $6, 'uploaded')
          RETURNING *
        `,
        [
          file.originalname,
          storedFileName,
          fileType,
          file.mimetype,
          file.size,
          authUserId,
        ]
      );

      const mediaFile = mediaInsert.rows[0];

      await client.query(
        `
          INSERT INTO media_storage_s3 (
            media_file_id,
            bucket_name,
            object_key,
            file_url,
            region
          )
          VALUES ($1, $2, $3, $4, $5)
        `,
        [mediaFile.id, S3_BUCKET, s3Key, publicUrl, AWS_REGION]
      );

      await client.query(
        `
          INSERT INTO course_content_media (
            course_content_id,
            media_file_id
          )
          VALUES ($1, $2)
        `,
        [contentId, mediaFile.id]
      );

      uploadedMedia.push({
        media_file_id: mediaFile.id,
        original_file_name: mediaFile.original_file_name,
        stored_file_name: mediaFile.stored_file_name,
        file_type: mediaFile.file_type,
        mime_type: mediaFile.mime_type,
        file_size_bytes: mediaFile.file_size_bytes,
        storage_provider: mediaFile.storage_provider,
        upload_status: mediaFile.upload_status,
        bucket_name: S3_BUCKET,
        object_key: s3Key,
        file_url: publicUrl,
        region: AWS_REGION,
      });
    }

    await client.query("COMMIT");

    return res.status(201).json({
      message: "Content media uploaded successfully",
      uploaded_count: uploadedMedia.length,
      media: uploadedMedia,
    });
  } catch (error) {
    if (transactionStarted) {
      await client.query("ROLLBACK");
    }
    console.error("uploadCourseContentMedia error:", error);
    return res.status(500).json({
      message: "Failed to upload content media",
      error: error.message,
    });
  } finally {
    client.release();
  }
}

export async function getCourseContentMediaSignedUrl(req, res) {
  try {
    const mediaFileId = Number(req.params.mediaFileId);

    if (!mediaFileId || Number.isNaN(mediaFileId)) {
      return res.status(400).json({ message: "Invalid media file id" });
    }

    const params = [mediaFileId];

    let query = `
      SELECT
        mf.id AS media_file_id,
        mf.original_file_name,
        mf.mime_type,
        ms3.bucket_name,
        ms3.object_key
      FROM media_files mf
      JOIN media_storage_s3 ms3
        ON ms3.media_file_id = mf.id
      JOIN course_content_media ccm
        ON ccm.media_file_id = mf.id
      JOIN course_contents cc
        ON cc.id = ccm.course_content_id
      JOIN courses c
        ON c.id = cc.course_id
      WHERE mf.id = $1
        AND c.deleted_at IS NULL
    `;

    query += addScopeWhere(req, "c", params, { includeGlobal: true });

    query += ` LIMIT 1`;

    const result = await db.query(query, params);

    if (!result.rowCount) {
      return res.status(404).json({ message: "Media file not found" });
    }

    const media = result.rows[0];

    const signedUrl = await getSignedUrl(
      s3,
      new GetObjectCommand({
        Bucket: media.bucket_name,
        Key: media.object_key,
        ResponseContentType: media.mime_type,
      }),
      { expiresIn: SIGNED_URL_EXPIRES }
    );

    return res.json({
      message: "Signed URL generated successfully",
      media_file_id: media.media_file_id,
      original_file_name: media.original_file_name,
      signed_url: signedUrl,
      expires_in_seconds: SIGNED_URL_EXPIRES,
    });
  } catch (error) {
    console.error("getCourseContentMediaSignedUrl error:", error);
    return res.status(500).json({
      message: "Failed to generate signed URL",
      error: error.message,
    });
  }
}

export async function deleteCourseContentMedia(req, res) {
  const client = await db.connect();

  try {
    const courseId = Number(req.params.courseId);
    const contentId = Number(req.params.contentId);
    const mediaFileId = Number(req.params.mediaFileId);

    if (!courseId || Number.isNaN(courseId)) {
      return res.status(400).json({ message: "Invalid course id" });
    }

    if (!contentId || Number.isNaN(contentId)) {
      return res.status(400).json({ message: "Invalid content id" });
    }

    if (!mediaFileId || Number.isNaN(mediaFileId)) {
      return res.status(400).json({ message: "Invalid media file id" });
    }

    const allowed = await checkCourseScope(req, courseId, client);

    if (!allowed) {
      return res.status(404).json({ message: "Course not found" });
    }

    const result = await client.query(
      `
      SELECT
        ccm.course_content_id,
        mf.id AS media_file_id,
        ms3.bucket_name,
        ms3.object_key
      FROM course_content_media ccm
      JOIN course_contents cc ON cc.id = ccm.course_content_id
      JOIN media_files mf ON mf.id = ccm.media_file_id
      LEFT JOIN media_storage_s3 ms3 ON ms3.media_file_id = mf.id
      WHERE cc.course_id = $1
        AND ccm.course_content_id = $2
        AND mf.id = $3
      LIMIT 1
      `,
      [courseId, contentId, mediaFileId]
    );

    if (!result.rowCount) {
      return res.status(404).json({ message: "Media mapping not found" });
    }

    const media = result.rows[0];

    await client.query("BEGIN");

    if (media.bucket_name && media.object_key) {
      await s3.send(
        new DeleteObjectCommand({
          Bucket: media.bucket_name,
          Key: media.object_key,
        })
      );
    }

    await client.query(`DELETE FROM course_content_media WHERE media_file_id = $1`, [mediaFileId]);
    await client.query(`DELETE FROM media_storage_s3 WHERE media_file_id = $1`, [mediaFileId]);
    await client.query(`DELETE FROM media_files WHERE id = $1`, [mediaFileId]);

    await client.query("COMMIT");

    return res.json({ message: "Content media deleted successfully" });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("deleteCourseContentMedia error:", error);
    return res.status(500).json({
      message: "Failed to delete content media",
      error: error.message,
    });
  } finally {
    client.release();
  }
}

export async function getCourseContentById(req, res) {
  try {
    const courseId = Number(req.params.courseId);
    const contentId = Number(req.params.contentId);

    if (!courseId || Number.isNaN(courseId)) {
      return res.status(400).json({ message: "Invalid course id" });
    }

    if (!contentId || Number.isNaN(contentId)) {
      return res.status(400).json({ message: "Invalid content id" });
    }

    const allowed = await checkCourseScope(req, courseId, db, { includeGlobal: true });

    if (!allowed) {
      return res.status(404).json({ message: "Course not found" });
    }

    const contentResult = await db.query(
      `
      SELECT *
      FROM course_contents
      WHERE id = $1
        AND course_id = $2
      LIMIT 1
      `,
      [contentId, courseId]
    );

    if (!contentResult.rowCount) {
      return res.status(404).json({ message: "Course content not found" });
    }

    return res.json({
      message: "Course content fetched successfully",
      content: contentResult.rows[0],
    });
  } catch (error) {
    console.error("getCourseContentById error:", error);
    return res.status(500).json({
      message: "Failed to fetch course content",
      error: error.message,
    });
  }
}

export async function getCourseContentMedia(req, res) {
  try {
    const courseId = Number(req.params.courseId);
    const contentId = Number(req.params.contentId);

    if (!courseId || Number.isNaN(courseId)) {
      return res.status(400).json({ message: "Invalid course id" });
    }

    if (!contentId || Number.isNaN(contentId)) {
      return res.status(400).json({ message: "Invalid content id" });
    }

    const allowed = await checkCourseScope(req, courseId, db, { includeGlobal: true });

    if (!allowed) {
      return res.status(404).json({ message: "Course not found" });
    }

    const contentCheck = await db.query(
      `
      SELECT id
      FROM course_contents
      WHERE id = $1
        AND course_id = $2
      LIMIT 1
      `,
      [contentId, courseId]
    );

    if (!contentCheck.rowCount) {
      return res.status(404).json({ message: "Course content not found" });
    }

    const mediaResult = await db.query(
      `
      SELECT
        ccm.course_content_id,
        mf.id AS media_file_id,
        mf.original_file_name,
        mf.stored_file_name,
        mf.file_type,
        mf.mime_type,
        mf.file_size_bytes,
        mf.storage_provider,
        mf.upload_status,
        mf.created_at AS media_created_at,
        ms3.bucket_name,
        ms3.object_key,
        ms3.file_url,
        ms3.region
      FROM course_content_media ccm
      JOIN media_files mf ON mf.id = ccm.media_file_id
      LEFT JOIN media_storage_s3 ms3 ON ms3.media_file_id = mf.id
      WHERE ccm.course_content_id = $1
      ORDER BY mf.id ASC
      `,
      [contentId]
    );

    return res.json({
      message: "Course content media fetched successfully",
      content_id: contentId,
      media: mediaResult.rows,
    });
  } catch (error) {
    console.error("getCourseContentMedia error:", error);
    return res.status(500).json({
      message: "Failed to fetch course content media",
      error: error.message,
    });
  }
}

export async function deleteCourseContent(req, res) {
  const client = await db.connect();

  try {
    const courseId = Number(req.params.courseId);
    const contentId = Number(req.params.contentId);

    if (!courseId || Number.isNaN(courseId)) {
      return res.status(400).json({ message: "Invalid course id" });
    }

    if (!contentId || Number.isNaN(contentId)) {
      return res.status(400).json({ message: "Invalid content id" });
    }

    const allowed = await checkCourseScope(req, courseId, client);

    if (!allowed) {
      return res.status(404).json({ message: "Course not found" });
    }

    const contentResult = await client.query(
      `
      SELECT id
      FROM course_contents
      WHERE id = $1
        AND course_id = $2
      LIMIT 1
      `,
      [contentId, courseId]
    );

    if (!contentResult.rowCount) {
      return res.status(404).json({ message: "Course content not found" });
    }

    const mediaResult = await client.query(
      `
      SELECT
        mf.id AS media_file_id,
        ms3.bucket_name,
        ms3.object_key
      FROM course_content_media ccm
      JOIN media_files mf ON mf.id = ccm.media_file_id
      LEFT JOIN media_storage_s3 ms3 ON ms3.media_file_id = mf.id
      WHERE ccm.course_content_id = $1
      `,
      [contentId]
    );

    await client.query("BEGIN");

    for (const media of mediaResult.rows) {
      if (media.bucket_name && media.object_key) {
        await s3.send(
          new DeleteObjectCommand({
            Bucket: media.bucket_name,
            Key: media.object_key,
          })
        );
      }

      await client.query(`DELETE FROM course_content_media WHERE media_file_id = $1`, [media.media_file_id]);
      await client.query(`DELETE FROM media_storage_s3 WHERE media_file_id = $1`, [media.media_file_id]);
      await client.query(`DELETE FROM media_files WHERE id = $1`, [media.media_file_id]);
    }

    await client.query(`DELETE FROM course_contents WHERE id = $1 AND course_id = $2`, [contentId, courseId]);

    await client.query("COMMIT");

    return res.json({
      message: "Course content deleted successfully",
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("deleteCourseContent error:", error);
    return res.status(500).json({
      message: "Failed to delete course content",
      error: error.message,
    });
  } finally {
    client.release();
  }
}

export async function createCourseContent(req, res) {
  try {
    const courseId = Number(req.params.courseId);
    const { content_title, content_description, content_type, youtube_url, sort_order } = req.body;

    if (!courseId || Number.isNaN(courseId)) {
      return res.status(400).json({ message: "Invalid course id" });
    }

    const params = [courseId];

    let checkQuery = `
      SELECT c.id
      FROM courses c
      WHERE c.id = $1
        AND c.deleted_at IS NULL
    `;

    checkQuery += addScopeWhere(req, "c", params);

    const courseCheck = await db.query(checkQuery, params);

    if (!courseCheck.rowCount) {
      return res.status(404).json({ message: "Course not found" });
    }

    const result = await db.query(
      `
      INSERT INTO course_contents (
        course_id,
        content_title,
        content_description,
        content_type,
        youtube_url,
        sort_order
      )
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
      `,
      [
        courseId,
        content_title,
        content_description,
        content_type,
        youtube_url || null,
        sort_order || 1,
      ]
    );

    return res.status(201).json({
      message: "Content created successfully",
      content: result.rows[0],
    });
  } catch (error) {
    console.error("createCourseContent error:", error);
    return res.status(500).json({
      message: "Failed to create content",
      error: error.message,
    });
  }
}

export async function updateCourseContent(req, res) {
  try {
    const courseId = Number(req.params.courseId);
    const contentId = Number(req.params.contentId);

    const { content_title, content_description, content_type, youtube_url, sort_order } = req.body;

    if (!courseId || Number.isNaN(courseId)) {
      return res.status(400).json({ message: "Invalid course id" });
    }

    if (!contentId || Number.isNaN(contentId)) {
      return res.status(400).json({ message: "Invalid content id" });
    }

    const allowed = await checkCourseScope(req, courseId, db, { includeGlobal: true });

    if (!allowed) {
      return res.status(404).json({ message: "Course not found" });
    }

    const result = await db.query(
      `
      UPDATE course_contents
      SET
        content_title = COALESCE($1, content_title),
        content_description = COALESCE($2, content_description),
        content_type = COALESCE($3, content_type),
        youtube_url = COALESCE($4, youtube_url),
        sort_order = COALESCE($5, sort_order),
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $6
        AND course_id = $7
      RETURNING *
      `,
      [
        content_title,
        content_description,
        content_type,
        youtube_url,
        sort_order,
        contentId,
        courseId,
      ]
    );

    if (!result.rowCount) {
      return res.status(404).json({ message: "Content not found" });
    }

    return res.json({
      message: "Content updated successfully",
      content: result.rows[0],
    });
  } catch (error) {
    console.error("updateCourseContent error:", error);
    return res.status(500).json({
      message: "Failed to update content",
      error: error.message,
    });
  }
}

export async function getCourseContentMediaById(req, res) {
  try {
    const courseId = Number(req.params.courseId);
    const contentId = Number(req.params.contentId);
    const mediaFileId = Number(req.params.mediaFileId);

    if (!courseId || Number.isNaN(courseId)) {
      return res.status(400).json({ message: "Invalid course id" });
    }

    if (!contentId || Number.isNaN(contentId)) {
      return res.status(400).json({ message: "Invalid content id" });
    }

    if (!mediaFileId || Number.isNaN(mediaFileId)) {
      return res.status(400).json({ message: "Invalid media file id" });
    }

    const allowed = await checkCourseScope(req, courseId, db, { includeGlobal: true });

    if (!allowed) {
      return res.status(404).json({ message: "Course not found" });
    }

    const result = await db.query(
      `
      SELECT
        mf.id AS media_file_id,
        mf.original_file_name,
        mf.mime_type,
        mf.file_size_bytes,
        ms3.file_url,
        ms3.object_key
      FROM course_content_media ccm
      JOIN media_files mf ON mf.id = ccm.media_file_id
      LEFT JOIN media_storage_s3 ms3 ON ms3.media_file_id = mf.id
      JOIN course_contents cc ON cc.id = ccm.course_content_id
      WHERE cc.id = $1
        AND cc.course_id = $2
        AND mf.id = $3
      LIMIT 1
      `,
      [contentId, courseId, mediaFileId]
    );

    if (!result.rowCount) {
      return res.status(404).json({ message: "Media not found" });
    }

    return res.json({
      message: "Media fetched successfully",
      media: result.rows[0],
    });
  } catch (error) {
    console.error("getCourseContentMediaById error:", error);
    return res.status(500).json({
      message: "Failed to fetch media",
      error: error.message,
    });
  }
}

export async function replaceCourseContentMedia(req, res) {
  const client = await db.connect();

  try {
    const courseId = Number(req.params.courseId);
    const contentId = Number(req.params.contentId);
    const mediaFileId = Number(req.params.mediaFileId);
    const file = req.file;

    if (!courseId || Number.isNaN(courseId)) {
      return res.status(400).json({ message: "Invalid course id" });
    }

    if (!contentId || Number.isNaN(contentId)) {
      return res.status(400).json({ message: "Invalid content id" });
    }

    if (!mediaFileId || Number.isNaN(mediaFileId)) {
      return res.status(400).json({ message: "Invalid media file id" });
    }

    if (!file) {
      return res.status(400).json({ message: "File required" });
    }

    const allowed = await checkCourseScope(req, courseId, client);

    if (!allowed) {
      return res.status(404).json({ message: "Course not found" });
    }

    const existing = await client.query(
      `
      SELECT
        ms3.bucket_name,
        ms3.object_key
      FROM course_content_media ccm
      JOIN course_contents cc ON cc.id = ccm.course_content_id
      JOIN media_files mf ON mf.id = ccm.media_file_id
      LEFT JOIN media_storage_s3 ms3 ON ms3.media_file_id = mf.id
      WHERE cc.course_id = $1
        AND cc.id = $2
        AND mf.id = $3
      LIMIT 1
      `,
      [courseId, contentId, mediaFileId]
    );

    if (!existing.rowCount) {
      return res.status(404).json({ message: "Media not found" });
    }

    if (existing.rows[0].bucket_name && existing.rows[0].object_key) {
      await s3.send(
        new DeleteObjectCommand({
          Bucket: existing.rows[0].bucket_name,
          Key: existing.rows[0].object_key,
        })
      );
    }

    const storedFileName = buildStoredFileName(file.originalname);
    const s3Key = `courses/${courseId}/contents/${contentId}/${storedFileName}`;

    await s3.send(
      new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: s3Key,
        Body: file.buffer,
        ContentType: file.mimetype,
      })
    );

    const publicUrl = `https://${S3_BUCKET}.s3.${AWS_REGION}.amazonaws.com/${s3Key}`;

    await client.query("BEGIN");

    await client.query(
      `
      UPDATE media_files
      SET
        original_file_name = $1,
        stored_file_name = $2,
        mime_type = $3,
        file_size_bytes = $4
      WHERE id = $5
      `,
      [file.originalname, storedFileName, file.mimetype, file.size, mediaFileId]
    );

    await client.query(
      `
      UPDATE media_storage_s3
      SET object_key = $1, file_url = $2
      WHERE media_file_id = $3
      `,
      [s3Key, publicUrl, mediaFileId]
    );

    await client.query("COMMIT");

    return res.json({ message: "Media replaced successfully" });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("replaceCourseContentMedia error:", error);
    return res.status(500).json({
      message: "Failed to replace media",
      error: error.message,
    });
  } finally {
    client.release();
  }
}

export async function reorderCourseContents(req, res) {
  const client = await db.connect();

  try {
    const courseId = Number(req.params.courseId);
    const { contents } = req.body;

    if (!courseId || Number.isNaN(courseId)) {
      return res.status(400).json({ message: "Invalid course id" });
    }

    if (!Array.isArray(contents) || !contents.length) {
      return res.status(400).json({ message: "contents array is required" });
    }

    const allowed = await checkCourseScope(req, courseId, client);

    if (!allowed) {
      return res.status(404).json({ message: "Course not found" });
    }

    await client.query("BEGIN");

    for (const item of contents) {
      await client.query(
        `
        UPDATE course_contents
        SET sort_order = $1,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = $2
          AND course_id = $3
        `,
        [item.sort_order, item.id, courseId]
      );
    }

    await client.query("COMMIT");

    return res.json({
      message: "Contents reordered successfully",
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("reorderCourseContents error:", error);
    return res.status(500).json({
      message: "Failed to reorder contents",
      error: error.message,
    });
  } finally {
    client.release();
  }
}

export async function completeCourseByLoggedInUser(req, res) {
  const client = await db.connect();

  try {
    const courseId = Number(req.params.courseId);
    const userId = getAuthUserId(req);

    if (!userId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    if (!courseId || Number.isNaN(courseId)) {
      return res.status(400).json({ message: "Invalid course id" });
    }

    const courseCheck = await client.query(
      `
      SELECT id, title, deleted_at
      FROM courses
      WHERE id = $1
        AND deleted_at IS NULL
      LIMIT 1
      `,
      [courseId]
    );

    const allowed = await checkCourseScope(req, courseId, client, { includeGlobal: true });

    if (!allowed) {
      return res.status(404).json({ message: "Course not found" });
    }

    if (!courseCheck.rowCount) {
      return res.status(404).json({ message: "Course not found" });
    }

    await client.query("BEGIN");

    const existingEnrollment = await client.query(
      `
      SELECT user_id, course_id, status, completion_status, completed_at
      FROM course_enrollments
      WHERE user_id = $1
        AND course_id = $2
      LIMIT 1
      `,
      [userId, courseId]
    );

    if (existingEnrollment.rowCount) {
      await client.query(
        `
        UPDATE course_enrollments
        SET
          status = 'completed',
          completion_status = 'completed',
          completed_at = NOW(),
          updated_at = NOW()
        WHERE user_id = $1
          AND course_id = $2
        `,
        [userId, courseId]
      );
    } else {
      await client.query(
        `
        INSERT INTO course_enrollments (
          user_id,
          course_id,
          status,
          enrolled_at,
          completion_status,
          completed_at,
          updated_at
        )
        VALUES ($1, $2, 'completed', NOW(), 'completed', NOW(), NOW())
        `,
        [userId, courseId]
      );
    }

    await client.query(
      `
      INSERT INTO course_completion_history (
        user_id,
        course_id,
        completed_at,
        created_at
      )
      VALUES ($1, $2, NOW(), NOW())
      `,
      [userId, courseId]
    );

    await client.query("COMMIT");

    return res.json({
      message: "Course marked as completed successfully",
      user_id: userId,
      course_id: courseId,
      completed_at: new Date().toISOString(),
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("completeCourseByLoggedInUser error:", error);
    return res.status(500).json({
      message: "Failed to mark course as completed",
      error: error.message,
    });
  } finally {
    client.release();
  }
}

export async function getMyCourseCompletionStatus(req, res) {
  try {
    const courseId = Number(req.params.courseId);
    const userId = getAuthUserId(req);

    if (!userId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    if (!courseId || Number.isNaN(courseId)) {
      return res.status(400).json({ message: "Invalid course id" });
    }

    const allowed = await checkCourseScope(req, courseId, db, { includeGlobal: true });

    if (!allowed) {
      return res.status(404).json({ message: "Course not found" });
    }

    const result = await db.query(
      `
      SELECT
        ce.user_id,
        ce.course_id,
        ce.status,
        ce.completion_status,
        ce.enrolled_at,
        ce.completed_at,
        c.title
      FROM course_enrollments ce
      JOIN courses c
        ON c.id = ce.course_id
      WHERE ce.user_id = $1
        AND ce.course_id = $2
        AND c.deleted_at IS NULL
      LIMIT 1
      `,
      [userId, courseId]
    );

    if (!result.rowCount) {
      return res.json({
        message: "No completion record found",
        completed: false,
        user_id: userId,
        course_id: courseId,
      });
    }

    const row = result.rows[0];

    return res.json({
      message: "Course completion status fetched successfully",
      completed: row.completion_status === "completed",
      completion: row,
    });
  } catch (error) {
    console.error("getMyCourseCompletionStatus error:", error);
    return res.status(500).json({
      message: "Failed to fetch course completion status",
      error: error.message,
    });
  }
}

export async function getMyCompletedCourses(req, res) {
  try {
    const userId = getAuthUserId(req);

    if (!userId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const params = [userId];

    let query = `
      SELECT
        ce.user_id,
        ce.course_id,
        ce.status,
        ce.completion_status,
        ce.enrolled_at,
        ce.completed_at,
        c.title,
        c.description,
        c.department,
        c.predefined_course_title,
        c.content_mode,
        c.certificate_prefix,
        c.company_id,
        c.ship_id,
        c.ranks,
        c.ship_types
      FROM course_enrollments ce
      JOIN courses c
        ON c.id = ce.course_id
      WHERE ce.user_id = $1
        AND ce.completion_status = 'completed'
        AND c.deleted_at IS NULL
    `;

    query += addScopeWhere(req, "c", params, { includeGlobal: true });

    query += `
      ORDER BY ce.completed_at DESC NULLS LAST, ce.enrolled_at DESC
    `;

    const result = await db.query(query, params);

    return res.json({
      message: "Completed courses fetched successfully",
      completed_courses: result.rows,
    });
  } catch (error) {
    console.error("getMyCompletedCourses error:", error);
    return res.status(500).json({
      message: "Failed to fetch completed courses",
      error: error.message,
    });
  }
}