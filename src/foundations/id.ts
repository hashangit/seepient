/**
 * Identity helpers — pure, dependency-free, importable by any layer.
 */

/**
 * Generate a unique identifier using crypto.randomUUID().
 */
export function generateId(): string {
  return crypto.randomUUID();
}
