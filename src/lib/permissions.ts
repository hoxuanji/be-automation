import { getProjectAccessRow } from "./db";

/**
 * Returns the user's effective permission on a project, or null when no
 * access exists. Single source of truth — all project routes (and any
 * future surfaces) MUST go through this function rather than re-encoding
 * the rule. Order: owner > edit > view > null.
 */
export type ProjectAccess = "owner" | "edit" | "view" | null;

export function getProjectAccess(projectId: string, userId: string): ProjectAccess {
  const row = getProjectAccessRow(projectId, userId);
  return row ? row.level : null;
}

/**
 * Helper for routes that need a minimum permission. Returns true when the
 * user holds at least the requested level. Use it like:
 *   if (!atLeast(access, "edit")) return new Response("forbidden", { status: 403 });
 */
export function atLeast(access: ProjectAccess, required: "view" | "edit" | "owner"): boolean {
  if (access === null) return false;
  const rank = { owner: 3, edit: 2, view: 1 } as const;
  return rank[access] >= rank[required];
}

/**
 * Returns true only when the access level allows reading a project.
 */
export function canRead(access: ProjectAccess): boolean {
  return access !== null;
}

/**
 * Returns true only when the access level allows mutating a project's
 * config / endpoints / entities. Owners + editors qualify.
 */
export function canWrite(access: ProjectAccess): boolean {
  return access === "owner" || access === "edit";
}

/**
 * Only the owner can delete a project or modify its share list.
 */
export function canManage(access: ProjectAccess): boolean {
  return access === "owner";
}
