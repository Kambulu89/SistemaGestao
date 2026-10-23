import type { PageRequest } from '../../api/pagination.model';
import type { FieldValue } from './field-definition.model';
import type { SemanticColor } from './status.model';

export type RecordData = Readonly<Record<string, FieldValue>>;

/** Estado de um registo numa máquina de estados do servidor (C13). */
export interface RecordStateInfo {
  readonly code: string;
  readonly label: string;
  readonly color: SemanticColor;
  readonly category: 'INITIAL' | 'ACTIVE' | 'FINAL' | 'CANCELLED';
  /** `false`: o servidor recusa alterações de valores neste estado. */
  readonly editable: boolean;
  /** Versão do estado: a `expectedVersion` das transições. */
  readonly version: number;
}

/** Uma transição que o servidor deixa o utilizador executar agora. */
export interface RecordAction {
  readonly code: string;
  readonly label: string;
  readonly toLabel: string;
  readonly reasonRequired: boolean;
}

export interface RecordActions {
  readonly version: number;
  readonly actions: readonly RecordAction[];
}

export interface TransitionOptions {
  readonly expectedVersion: number;
  readonly reason?: string;
}

export interface EntityRecord {
  readonly id: string;
  readonly entityKey: string;
  readonly tenantId: string;
  /** Versão da definição em vigor quando o registo foi escrito pela última vez. */
  readonly definitionVersion: number;
  readonly status: string | null;
  /** Estado na máquina de estados do servidor (só nos registos que a têm). */
  readonly state?: RecordStateInfo;
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
  /** Nome de apresentação do autor, resolvido pelo servidor. */
  readonly actorName: string;
  readonly at: string;
  readonly changes: readonly AuditChange[];
}

/** Pedido de opções para um campo de referência: por texto e/ou por ids já seleccionados. */
export interface ReferenceLookupQuery {
  readonly search?: string;
  readonly ids?: readonly string[];
}

/**
 * Alvo especial de `lookup`: o directório de utilizadores do tenant. Devolve só o identificador
 * e o nome (nunca email nem papéis), e só os membros do tenant activo.
 */
export const USER_DIRECTORY_KEY = '@user';

export interface ReferenceOption {
  readonly id: string;
  readonly label: string;
}
