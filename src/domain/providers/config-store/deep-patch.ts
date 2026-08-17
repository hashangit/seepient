/**
 * Deep patch algorithm supporting nested nulls for explicit unsetting / deletions.
 *
 * Rules:
 * - Absent field in patch: preserves existing target value.
 * - Primitive / Object value in patch: overrides / deep-merges into target.
 * - `null` in patch: deletes / unsets the corresponding field or map entry.
 * - Arrays in patch: replaced wholesale unless `null` (which unsets).
 */
export function applyDeepPatch(target: any, patch: any): any {
  if (patch === undefined) {
    return target;
  }

  if (patch === null) {
    return undefined;
  }

  if (typeof patch !== "object" || Array.isArray(patch)) {
    return patch;
  }

  const result = typeof target === "object" && target !== null && !Array.isArray(target)
    ? { ...target }
    : {};

  for (const [key, patchVal] of Object.entries(patch)) {
    if (patchVal === undefined) {
      continue;
    }

    if (patchVal === null) {
      delete result[key];
    } else if (Array.isArray(patchVal)) {
      result[key] = patchVal;
    } else if (typeof patchVal === "object") {
      result[key] = applyDeepPatch(result[key], patchVal);
    } else {
      result[key] = patchVal;
    }
  }

  return result;
}

/**
 * Merges two patch documents, preserving explicit `null` unsetting markers in the resulting patch.
 */
export function mergePatches(targetPatch: any, newPatch: any): any {
  if (newPatch === undefined) {
    return targetPatch;
  }
  if (newPatch === null || typeof newPatch !== "object" || Array.isArray(newPatch)) {
    return newPatch;
  }

  const result = typeof targetPatch === "object" && targetPatch !== null && !Array.isArray(targetPatch)
    ? { ...targetPatch }
    : {};

  for (const [key, patchVal] of Object.entries(newPatch)) {
    if (patchVal === undefined) {
      continue;
    }
    if (patchVal === null) {
      result[key] = null;
    } else if (Array.isArray(patchVal)) {
      result[key] = patchVal;
    } else if (typeof patchVal === "object") {
      result[key] = mergePatches(result[key], patchVal);
    } else {
      result[key] = patchVal;
    }
  }

  return result;
}
