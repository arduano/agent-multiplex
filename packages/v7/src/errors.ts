export class V7Error extends Error {
  public constructor(public readonly code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "V7Error";
  }
}

/** An explicit proof supplied by the native boundary; never inferred from text. */
export class NativeOperationError extends V7Error {
  public constructor(code: string, message: string, public readonly certainty: "failed" | "outcomeUnknown", options?: ErrorOptions) {
    super(code, message, options);
    this.name = "NativeOperationError";
  }
}

export function errorDetails(error: unknown): { code: string; message: string } {
  return { code: error instanceof V7Error ? error.code : "NATIVE_FAILURE",
    message: error instanceof Error ? error.message : "Operation failed" };
}
