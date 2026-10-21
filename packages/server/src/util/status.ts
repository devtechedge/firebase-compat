// gRPC canonical status codes as used by Firestore on every transport.
export const CODES: Record<string, number> = {
  OK: 0, CANCELLED: 1, UNKNOWN: 2, INVALID_ARGUMENT: 3, DEADLINE_EXCEEDED: 4, NOT_FOUND: 5, ALREADY_EXISTS: 6,
  PERMISSION_DENIED: 7, RESOURCE_EXHAUSTED: 8, FAILED_PRECONDITION: 9, ABORTED: 10, OUT_OF_RANGE: 11,
  UNIMPLEMENTED: 12, INTERNAL: 13, UNAVAILABLE: 14, DATA_LOSS: 15, UNAUTHENTICATED: 16,
};
const HTTP: Record<string, number> = {
  INVALID_ARGUMENT: 400, FAILED_PRECONDITION: 400, OUT_OF_RANGE: 400, UNAUTHENTICATED: 401, PERMISSION_DENIED: 403,
  NOT_FOUND: 404, ALREADY_EXISTS: 409, ABORTED: 409, RESOURCE_EXHAUSTED: 429, CANCELLED: 499, UNIMPLEMENTED: 501,
  UNAVAILABLE: 503, DEADLINE_EXCEEDED: 504,
};

export class RpcError extends Error {
  constructor(public status: string, message: string) { super(message); }
  get code(): number { return CODES[this.status] ?? 2; }
  get httpStatus(): number { return HTTP[this.status] ?? 500; }
  toJSON() { return { error: { code: this.httpStatus, message: this.message, status: this.status } }; }
}
