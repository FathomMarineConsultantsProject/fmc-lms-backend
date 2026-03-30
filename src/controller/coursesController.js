import { db } from "../db.js";

const VALID_CONTENT_MODES = new Set(["single_training", "course"]);
const VALID_CONTENT_TYPES = new Set([
    "youtube",
    "document",
    "video_file",
    "image",
    "ppt",
]);
import crypto from "crypto";
import { PutObjectCommand, DeleteObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { s3, S3_BUCKET, AWS_REGION, SIGNED_URL_EXPIRES } from "../config/s3.js";

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

        await client.query("BEGIN");

        const courseInsert = await client.query(
            `
        INSERT INTO courses (
          title,
          description,
          department,
          predefined_course_title,
          status,
          content_mode,
          created_by,
          updated_by
        )
        VALUES ($1, $2, $3, $4, 'draft', $5, $6, $6)
        RETURNING
          id,
          title,
          description,
          department,
          predefined_course_title,
          status,
          content_mode,
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
                authUserId,
            ]
        );

        const course = courseInsert.rows[0];
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
        const result = await db.query(
            `
        SELECT
          c.id,
          c.title,
          c.description,
          c.department,
          c.predefined_course_title,
          c.status,
          c.content_mode,
          c.created_by,
          c.updated_by,
          c.created_at,
          c.updated_at,
          COUNT(cc.id)::int AS contents_count
        FROM courses c
        LEFT JOIN course_contents cc
          ON cc.course_id = c.id
        WHERE c.deleted_at IS NULL
        GROUP BY c.id
        ORDER BY c.created_at DESC
      `
        );

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

        const course = await fetchCourseWithContents(courseId);

        if (!course) {
            return res.status(404).json({ message: "Course not found" });
        }

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

        const result = await db.query(
            `
        SELECT
          c.id,
          c.title,
          c.description,
          c.department,
          c.predefined_course_title,
          c.status,
          c.content_mode,
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
        GROUP BY
          c.id,
          ce.status,
          ce.enrolled_at
        ORDER BY ce.enrolled_at DESC
      `,
            [userId]
        );

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

        const existingCourse = await client.query(
            `
        SELECT id
        FROM courses
        WHERE id = $1
          AND deleted_at IS NULL
      `,
            [courseId]
        );

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
        WHEN $4_present THEN $4
        ELSE predefined_course_title
      END,
      content_mode = COALESCE($5, content_mode),
      updated_by = $6
    WHERE id = $7
  `.replace("$4_present", bodyHasPredefinedCourseTitle ? "TRUE" : "FALSE"),
            [
                payload.title,
                payload.description,
                payload.department,
                payload.predefined_course_title,
                payload.content_mode,
                authUserId,
                courseId,
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

        const result = await db.query(
            `
        UPDATE courses
        SET deleted_at = CURRENT_TIMESTAMP
        WHERE id = $1
          AND deleted_at IS NULL
        RETURNING id
      `,
            [courseId]
        );

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

  try {
    const courseId = Number(req.params.courseId);
    const contentId = Number(req.params.contentId);
    const authUserId = getAuthUserId(req);
    const file = req.file;

    if (!courseId || Number.isNaN(courseId)) {
      return res.status(400).json({ message: "Invalid course id" });
    }

    if (!contentId || Number.isNaN(contentId)) {
      return res.status(400).json({ message: "Invalid content id" });
    }

    if (!file) {
      return res.status(400).json({ message: "File is required" });
    }

    const fileType = getFileTypeFromMime(file.mimetype);
    if (!fileType) {
      return res.status(400).json({ message: "Unsupported file type" });
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

    if (content.content_type !== fileType) {
      return res.status(400).json({
        message: `Uploaded file type (${fileType}) does not match content type (${content.content_type})`,
      });
    }

    const existingMedia = await client.query(
      `
        SELECT ccm.id
        FROM course_content_media ccm
        WHERE ccm.course_content_id = $1
        LIMIT 1
      `,
      [contentId]
    );

    if (existingMedia.rowCount) {
      return res.status(400).json({
        message: "This content already has a media file. Delete old file first or replace flow later.",
      });
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

    await client.query("COMMIT");

    return res.status(201).json({
      message: "Content media uploaded successfully",
      media: {
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
      },
    });
  } catch (error) {
    await client.query("ROLLBACK");
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

    const result = await db.query(
      `
        SELECT
          mf.id AS media_file_id,
          mf.original_file_name,
          mf.mime_type,
          ms3.bucket_name,
          ms3.object_key
        FROM media_files mf
        JOIN media_storage_s3 ms3
          ON ms3.media_file_id = mf.id
        WHERE mf.id = $1
        LIMIT 1
      `,
      [mediaFileId]
    );

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

    const result = await client.query(
      `
        SELECT
          ccm.course_content_id,
          mf.id AS media_file_id,
          ms3.bucket_name,
          ms3.object_key
        FROM course_content_media ccm
        JOIN course_contents cc
          ON cc.id = ccm.course_content_id
        JOIN media_files mf
          ON mf.id = ccm.media_file_id
        LEFT JOIN media_storage_s3 ms3
          ON ms3.media_file_id = mf.id
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

    return res.json({
      message: "Content media deleted successfully",
    });
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