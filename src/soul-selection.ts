/** Shared by Pi and the generated Claude sandbox entry. No host or Node dependencies. */
export function isSoulName(value: unknown): value is string {
  return typeof value === "string" && /^[\p{L}\p{N}_-][\p{L}\p{N}_.-]*$/u.test(value);
}

/** Exact keys always win; otherwise the first wildcard wins. Only `*` is special. */
export function matchingModelKey(model: string, keys: readonly string[]): string | undefined {
  if (keys.includes(model)) return model;
  return keys.find((pattern) => {
    if (!pattern.includes("*")) return false;
    const escaped = pattern.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*");
    return new RegExp(`^${escaped}$`).test(model);
  });
}
