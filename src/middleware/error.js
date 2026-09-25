export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export const badRequest = (msg, details) => new HttpError(400, msg, details);
export const notFound = (msg = 'Not found') => new HttpError(404, msg);
export const conflict = (msg, details) => new HttpError(409, msg, details);
export const forbidden = (msg) => new HttpError(403, msg);

/** Wraps an async route so rejected promises reach the error handler. */
export const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export function notFoundHandler(req, _res, next) {
  next(new HttpError(404, `No route for ${req.method} ${req.path}`));
}

// eslint-disable-next-line no-unused-vars -- Express needs the 4-arg signature
export function errorHandler(err, req, res, _next) {
  let status = err.status || 500;
  let message = err.message || 'Internal server error';

  /* NFR-4.2 asks for specific, actionable messages. A raw PostgreSQL violation
     is neither, so the ones the API can actually provoke are translated here
     rather than leaking "duplicate key value violates unique constraint". */
  if (err.code === '23505') {
    status = 409;
    message = err.constraint === 'allocations_line_table_key'
      ? 'That line is already allocated to this table'
      : err.constraint === 'packing_txns_one_running_per_member'
      ? 'You already have packing in progress — submit it before starting another'
      : 'That record already exists';
  } else if (err.code === '23503') {
    status = 400;
    message = 'A referenced record (shift, line, table or user) does not exist';
  } else if (err.code === '23514') {
    status = 400;
    message = 'A value is outside the range this field accepts';
  }

  if (status >= 500) console.error('[spd]', req.method, req.originalUrl, err);
  res.status(status).json({
    error: message,
    ...(err.details ? { details: err.details } : {}),
  });
}
