/** Errors that map to an HTTP status. Anything else is a 500. */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'AppError';
  }
}

export const unauthorized = (code = 'unauthorized') => new AppError(401, code);
export const forbidden = (code = 'forbidden') => new AppError(403, code);
export const notFound = (code = 'not_found') => new AppError(404, code);
export const conflict = (code: string) => new AppError(409, code);
export const gone = (code: string) => new AppError(410, code);
export const badRequest = (code: string) => new AppError(400, code);
