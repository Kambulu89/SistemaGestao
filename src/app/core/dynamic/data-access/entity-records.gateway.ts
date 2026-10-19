import type { Observable } from 'rxjs';
import type { Page } from '../../api/pagination.model';
import type {
  AuditEntry,
  CreateRecordInput,
  EntityRecord,
  RecordQuery,
  ReferenceOption,
  UpdateRecordInput,
} from '../models/entity-record.model';

/**
 * Contrato com o backend para registos de entidades dinâmicas. O servidor é a autoridade:
 * isola por tenant, valida (incluindo `unique`), aplica permissões e políticas, audita e
 * controla a concorrência. Falhas de validação chegam como `ApiError` 422 com
 * `details: RecordValidationFailure`.
 */
export abstract class EntityRecordsGateway {
  abstract list(entityKey: string, query: RecordQuery): Observable<Page<EntityRecord>>;
  abstract get(entityKey: string, id: string): Observable<EntityRecord>;
  abstract create(entityKey: string, input: CreateRecordInput): Observable<EntityRecord>;
  abstract update(
    entityKey: string,
    id: string,
    input: UpdateRecordInput,
  ): Observable<EntityRecord>;
  abstract delete(entityKey: string, id: string): Observable<void>;
  abstract transition(
    entityKey: string,
    id: string,
    transitionKey: string,
  ): Observable<EntityRecord>;
  abstract audit(entityKey: string, id: string): Observable<readonly AuditEntry[]>;
  /** Opções para campos `reference`: registos da entidade alvo que correspondem à pesquisa. */
  abstract lookup(entityKey: string, search: string): Observable<readonly ReferenceOption[]>;
}
