import multer from 'multer';
import { config } from '../config.js';
import { badRequest } from './error.js';

/* The GRN file is parsed in memory and then discarded — only the rows it
   produced are kept. Nothing about the original spreadsheet needs to survive
   the request, and not writing it to disk keeps supplier pricing out of the
   filesystem. */
export const grnUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxUploadBytes, files: 1 },
  fileFilter(_req, file, cb) {
    const ok = /\.(xlsx|xls|csv)$/i.test(file.originalname);
    if (!ok) return cb(badRequest(`${file.originalname} is not a GRN export — upload the .xlsx or .csv exported from SAP (FR-1.1)`));
    cb(null, true);
  },
}).single('file');

/** Turns multer's own errors into the API's message shape. */
export function handleUploadErrors(err, _req, _res, next) {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return next(badRequest(`That file is larger than the ${Math.round(config.maxUploadBytes / 1024 / 1024)} MB upload limit`));
    }
    return next(badRequest(err.message));
  }
  return next(err);
}
