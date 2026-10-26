/** Normalizes a thrown/rejected value to an Error, keeping the original as `cause` when it wasn't one. */
export const toError = (value: unknown): Error =>
  value instanceof Error ? value : new Error(String(value), { cause: value });
