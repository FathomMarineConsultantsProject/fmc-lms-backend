import multer from "multer";

const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20 MB

const storage = multer.memoryStorage();

const allowedMimeTypes = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",

  "video/mp4",
  "video/mpeg",
  "video/quicktime",
  "video/x-msvideo",
  "video/x-matroska",

  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",

  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
]);

function fileFilter(req, file, cb) {
  if (!allowedMimeTypes.has(file.mimetype)) {
    return cb(new Error(`Unsupported file type: ${file.mimetype}`), false);
  }
  cb(null, true);
}

export const uploadCourseFiles = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: MAX_FILE_SIZE,
    files: 1,
  },
});