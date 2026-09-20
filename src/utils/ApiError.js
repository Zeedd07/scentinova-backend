export class ApiError extends Error {
  constructor(statusCode, code, message, fields = null) {
    super(message)
    this.statusCode = statusCode
    this.code = code
    this.fields = fields
    this.isOperational = true
  }
}

export function assertFound(value, code = 'NOT_FOUND', message = 'Resource not found.') {
  if (!value) throw new ApiError(404, code, message)
  return value
}
