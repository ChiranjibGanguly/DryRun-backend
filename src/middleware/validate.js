import { HttpError } from '../utils/httpError.js';

function check(schema, value) {
  const result = schema.safeParse(value ?? {});
  if (!result.success) {
    const details = result.error.issues.map((i) => ({
      field: i.path.join('.'),
      message: i.message,
    }));
    throw new HttpError(400, details[0]?.message || 'Invalid input', details);
  }
  return result.data;
}

/** Validate req.body against a zod schema; replaces body with the parsed value. */
export const validateBody = (schema) => (req, _res, next) => {
  try {
    req.body = check(schema, req.body);
    next();
  } catch (err) {
    next(err);
  }
};

/** Validate req.query; the parsed value is put on req.validQuery. */
export const validateQuery = (schema) => (req, _res, next) => {
  try {
    req.validQuery = check(schema, req.query);
    next();
  } catch (err) {
    next(err);
  }
};
