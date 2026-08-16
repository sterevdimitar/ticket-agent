import type { InvocationLogEntry } from "../types.js";

const entries: InvocationLogEntry[] = [];

/** Append-only by design: there is no update or remove API. */
export function append(entry: InvocationLogEntry): void {
  entries.push(entry);
}

/** Returns a copy so callers cannot rewrite the audit record. */
export function all(): readonly InvocationLogEntry[] {
  return entries.slice();
}

export function reset(): void {
  entries.length = 0;
}
