import { db } from "../db.js";

const VALID_CONTENT_MODES = new Set(["single_training", "course"]);
const VALID_CONTENT_TYPES = new Set([
    "youtube",
    "document",
    "video_file",
    "image",
    "ppt",
]);

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

    return {
        ...courseResult.rows[0],
        contents: contentsResult.rows,
    };
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