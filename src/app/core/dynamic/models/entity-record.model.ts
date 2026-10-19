import type { PageRequest } from '../../api/pagination.model';
import type { FieldValue } from './field-definition.model';

export type RecordData = Readonly<Record<string, FieldValue>>;

export interface EntityRecord {
  readonly id: string;
  readonly entityKey: string;
  readonly tenantId: string;
  /** Versão da definição em vigor quando o registo foi escrito pela última vez. */
  readonly definitionVersion: number;
  readonly status: string | null;
  readonly data: RecordData;
  /** Controlo de concorrência optimista. */
  readonly rowVersion: number;
  readonly createdAt: string;
  readonly createdBy: string;
  readonly updatedAt: string;
  readonly updatedBy: string;
}

export interface RecordQuery extends PageRequest {
  /** Texto pesquisado nos campos `searchFields`. */
  readonly search?: string;
}

export interface CreateRecordInput {
  readonly data: RecordData;
}

export interface UpdateRecordInput {
  readonly data: RecordData;
  /** `rowVersion` conhecida pelo cliente; o servidor rejeita se entretanto mudou. */
  readonly expectedRowVersion: number;
}

export type AuditAction = 'create' | 'update' | 'delete' | 'transition';

export interface AuditChange {
  readonly field: string;
  readonly from: FieldValue | undefined;
  readonly to: FieldValue | undefined;
}

export interface AuditEntry {
  readonly id: string;
  readonly entityKey: string;
  readonly recordId: string;
  readonly tenantId: string;
  readonly action: AuditAction;
  readonly actorId: string;
  readonly at: string;
  readonly changes: readonly AuditChange[];
}

export interface ReferenceOption {
  readonly id: string;
  readonly label: string;
}
