/**
 * Typed, application-level error raised by the production composition root and
 * runtime. Thrown during bootstrap for invalid configuration, missing durable
 * credentials, or an unavailable storage backend (fail-closed). Never carries
 * secrets or connection strings.
 */
export class DiagnosticError extends Error {
  readonly code: string;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(
    message: string,
    options: { readonly code?: string; readonly details?: Readonly<Record<string, unknown>> } = {},
  ) {
    super(message);
    this.name = 'DiagnosticError';
    this.code = options.code ?? 'COMPOSITION_ERROR';
    this.details = options.details;
  }
}
