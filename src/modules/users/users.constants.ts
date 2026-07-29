/**
 * Roles that may be assigned to a user through the admin API.
 *
 * Deliberately a plain literal list rather than the generated Prisma `RoleName` enum: the client
 * in this repository is never regenerated, so it does not yet know about `lawyer` (Phase 19).
 * Validating against `RoleName` would reject a perfectly valid role until the VPS runs
 * `prisma generate`.
 */
export const ASSIGNABLE_ROLE_NAMES = ['user', 'admin', 'content_manager', 'lawyer'] as const;

export type AssignableRoleName = (typeof ASSIGNABLE_ROLE_NAMES)[number];

/** Roles whose holders may reach staff-only listings. */
export const STAFF_ROLE_NAMES = ['admin', 'content_manager', 'lawyer'] as const;
