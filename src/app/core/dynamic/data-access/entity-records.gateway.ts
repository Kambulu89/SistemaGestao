import type { Observable } from 'rxjs';
import type { Page } from '../../api/pagination.model';
import type {
  AuditEntry,
  CreateRecordInput,
  EntityRecord,
  RecordActions,
  RecordQuery,
  ReferenceLookupQuery,
  ReferenceOption,
  TransitionOptions,
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
    options?: TransitionOptions,
  ): Observable<EntityRecord>;
  /**
   * As transições que o utilizador pode executar agora, decididas pelo servidor (permissões, guardas e estado).
   * `null`: o registo não tem máquina de estados no servidor (a interface usa o workflow local, se existir).
   */
  abstract availableActions(entityKey: string, id: string): Observable<RecordActions | null>;
  abstract audit(entityKey: string, id: string): Observable<readonly AuditEntry[]>;
  /** Opções para campos `reference`: registos da entidade alvo que correspondem à pesquisa ou aos ids. */
  abstract lookup(
    entityKey: string,
    query: ReferenceLookupQuery,
  ): Observable<readonly ReferenceOption[]>;
}
