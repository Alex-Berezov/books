import { RESOLVED_ACTION_STATUSES } from './rights-action.constants';
import type { RightsActionDto } from './dto/rights-profile-response.dto';

const toIsoOrNull = (value: unknown): string | null =>
  value ? new Date(value as string).toISOString() : null;

/** Единая проекция `RightsAction` в DTO — используется и профилем, и эндпоинтом действия. */
export const mapRightsAction = (record: Record<string, unknown>): RightsActionDto => ({
  id: record['id'] as string,
  rightsProfileId: record['rightsProfileId'] as string,
  actionType: record['actionType'] as string,
  status: record['status'] as string,
  descriptionRu: record['descriptionRu'] as string,
  affectedCountryCodes: record['affectedCountryCodes'],
  isBlocking: record['isBlocking'] as boolean,
  assignedToUserId: (record['assignedToUserId'] as string) ?? null,
  dueAt: toIsoOrNull(record['dueAt']),
  completedAt: toIsoOrNull(record['completedAt']),
  completedByUserId: (record['completedByUserId'] as string) ?? null,
  completionNotesRu: (record['completionNotesRu'] as string) ?? null,
  isResolved: (RESOLVED_ACTION_STATUSES as readonly string[]).includes(record['status'] as string),
  createdAt: new Date(record['createdAt'] as string).toISOString(),
  updatedAt: new Date(record['updatedAt'] as string).toISOString(),
});
