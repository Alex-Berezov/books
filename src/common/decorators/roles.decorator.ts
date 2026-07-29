import { SetMetadata } from '@nestjs/common';

export enum Role {
  User = 'user',
  Admin = 'admin',
  ContentManager = 'content_manager',
  /** Phase 19: lawyer. Access limited to the legal review workflow. */
  Lawyer = 'lawyer',
}

export const ROLES_KEY = 'roles';
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);
