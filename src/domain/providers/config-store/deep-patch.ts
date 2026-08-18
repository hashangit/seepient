/**
 * Deep patch algorithm supporting nested nulls for explicit unsetting / deletions.
 *
 * Rules:
 * - Absent field in patch: preserves existing target value.
 * - Primitive / Object value in patch: overrides / deep-merges into target.
 * - `null` in patch: deletes / unsets the corresponding field or map entry.
 * - Arrays in patch: replaced wholesale unless `null` (which unsets).
 * - `modelAssignments.<purpose>.<tier>` slots: replaced wholesale per slot.
 */
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export function applyDeepPatch(target: any, patch: any, path: string[] = []): any {
  if (patch === undefined) {
    return target;
  }

  if (patch === null) {
    return undefined;
  }

  if (typeof patch !== "object" || Array.isArray(patch)) {
    return patch;
  }

  if (
    path.length === 0 &&
    typeof patch.providerAccount === "string" &&
    typeof patch.model === "string"
  ) {
    return patch;
  }

  const result =
    typeof target === "object" && target !== null && !Array.isArray(target)
      ? Object.assign(Object.create(null), target)
      : Object.create(null);

  for (const [key, patchVal] of Object.entries(patch)) {
    if (FORBIDDEN_KEYS.has(key) || patchVal === undefined) {
      continue;
    }

    const currentPath = [...path, key];
    const isModelAssignmentSlot =
      (currentPath.length === 3 && currentPath[0] === "modelAssignments") ||
      (currentPath.length === 2 && ["text", "plan", "coding", "vision", "commit", "media"].includes(currentPath[0])) ||
      (patchVal && typeof patchVal === "object" && "providerAccount" in patchVal && "model" in patchVal);

    if (patchVal === null) {
      delete result[key];
    } else if (
      isModelAssignmentSlot ||
      Array.isArray(patchVal) ||
      (patchVal && typeof patchVal === "object" && typeof (patchVal as any).kind === "string")
    ) {
      result[key] = patchVal;
    } else if (typeof patchVal === "object") {
      result[key] = applyDeepPatch(result[key], patchVal, currentPath);
    } else {
      result[key] = patchVal;
    }
  }

  return { ...result };
}

/**
 * Merges two patch documents, preserving explicit `null` unsetting markers in the resulting patch.
 */
export function mergePatches(targetPatch: any, newPatch: any, path: string[] = []): any {
  if (newPatch === undefined) {
    return targetPatch;
  }
  if (newPatch === null || typeof newPatch !== "object" || Array.isArray(newPatch)) {
    return newPatch;
  }

  const result =
    typeof targetPatch === "object" && targetPatch !== null && !Array.isArray(targetPatch)
      ? Object.assign(Object.create(null), targetPatch)
      : Object.create(null);

  for (const [key, patchVal] of Object.entries(newPatch)) {
    if (FORBIDDEN_KEYS.has(key) || patchVal === undefined) {
      continue;
    }

    const currentPath = [...path, key];
    const isModelAssignmentSlot = currentPath.length === 3 && currentPath[0] === "modelAssignments";

    if (patchVal === null) {
      result[key] = null;
    } else if (
      isModelAssignmentSlot ||
      Array.isArray(patchVal) ||
      (patchVal && typeof patchVal === "object" && typeof (patchVal as any).kind === "string")
    ) {
      result[key] = patchVal;
    } else if (typeof patchVal === "object") {
      result[key] = mergePatches(result[key], patchVal, currentPath);
    } else {
      result[key] = patchVal;
    }
  }

  return { ...result };
}
