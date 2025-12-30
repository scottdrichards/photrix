/** Escapes the '%', '_' and '\' characters in a string for use in a SQL LIKE clause */
export const escapeLikeLiteral = (value: string): string => value.replace(/[\\%_]/g, (m) => `\\${m}`);