import { db } from '../db.js';

const cleanText = (value, limit) => String(value || '')
  .replace(/<[^>]*>/g, ' ').replace(/&nbsp;|&#160;/gi, ' ')
  .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
  .replace(/\s+/g, ' ').trim().slice(0, limit);

export async function getCourseAssessmentContext(req, courseId) {
  if (![1, 2].includes(Number(req.user?.role_id)) ||
      !Number.isSafeInteger(Number(courseId)) || Number(courseId) < 1) return null;

  const result = await db.query(`SELECT id, title, description, department FROM courses
    WHERE id = $1 AND deleted_at IS NULL
      AND ($2::int = 1 OR company_id = $3)`,
    [courseId, Number(req.user.role_id), req.user.company_id || null]);
  if (!result.rowCount) return null;
  const course = result.rows[0];
  const contents = await db.query(`SELECT content_title, content_description FROM course_contents
    WHERE course_id = $1 ORDER BY sort_order, id`, [courseId]);
  const sections = new Map();
  for (const row of contents.rows) {
    const match = String(row.content_title || '').match(/^\[(.*?)\]\s*-\s*(.*)$/);
    const section = match ? match[1] : 'Course materials';
    const title = match ? match[2] : row.content_title;
    if (!sections.has(section)) sections.set(section, []);
    const description = cleanText(row.content_description, 160);
    const useful = description && !/^(auto[- ]generated topic|untitled|n\/?a|none|no description)$/i.test(description);
    sections.get(section).push({ content_title: cleanText(title, 180),
      ...(useful ? { content_description: description } : {}) });
  }
  const title = cleanText(course.title, 200);
  const department = cleanText(course.department, 80);
  const instruction = 'Use only this course metadata. Cover its sections broadly. Avoid precise facts or procedures unsupported by the metadata.';
  const outline = [...sections].flatMap(([section, items]) => [
    `Section: ${cleanText(section, 100)}`,
    ...items.map(item => `- ${cleanText(item.content_title, 110)}`)
  ]).join('\n');
  let prompt = `${instruction}\nCourse: ${title}\nDepartment: ${department}\n${outline}`;
  const overview = `\nOverview: ${cleanText(course.description, 800)}`;
  prompt += overview.slice(0, Math.max(0, 2000 - prompt.length));
  for (const items of sections.values()) for (const item of items) {
    if (!item.content_description) continue;
    const extra = `\n${cleanText(item.content_title, 70)}: ${item.content_description}`;
    if (prompt.length + extra.length <= 2000) prompt += extra;
  }
  return { title, department, description: prompt.slice(0, 2000) };
}
