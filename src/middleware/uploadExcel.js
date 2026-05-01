import multer from "multer";

const storage = multer.memoryStorage();

export const uploadExcel = multer({
  storage,
  fileFilter: (req, file, cb) => {
    if (
      file.mimetype.includes("spreadsheet") ||
      file.originalname.endsWith(".xlsx")
    ) {
      cb(null, true);
    } else {
      cb(new Error("Only Excel files allowed"), false);
    }
  },
});