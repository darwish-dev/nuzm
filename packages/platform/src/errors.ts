/** Domain-level error carrying a stable code from the registry (spec/openapi/errors.yaml). */
export class PlatformError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'PlatformError';
  }
}
