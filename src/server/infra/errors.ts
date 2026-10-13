export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const badRequest = (message: string) => new AppError(400, 'VALIDATION', message);
export const unauthorized = (message = 'Du behöver logga in') => new AppError(401, 'UNAUTHORIZED', message);
export const forbidden = (message = 'Du har inte behörighet för detta') => new AppError(403, 'FORBIDDEN', message);
export const notFound = (message = 'Hittades inte') => new AppError(404, 'NOT_FOUND', message);
/** BR-16: förväntad status stämde inte, transaktionen rullas tillbaka. */
export const conflict = (message: string) => new AppError(409, 'CONFLICT', message);
