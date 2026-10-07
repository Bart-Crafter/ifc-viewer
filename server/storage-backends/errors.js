// Backend-neutral failures: "exists" (name taken), "missing" (no such file), "unavailable" (storage unreachable / not permitted).
export class StorageError extends Error {
  constructor(code, message, status) {
    super(message || code);
    this.code = code;
    this.status = status;
  }
}
