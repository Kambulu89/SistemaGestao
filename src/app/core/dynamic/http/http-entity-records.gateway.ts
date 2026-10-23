import { inject, Injectable } from '@angular/core';
import { catchError, forkJoin, map, type Observable, of, switchMap, throwError } from 'rxjs';
import type { ApiError } from '../../api/api-error.model';
import { ApiService } from '../../api/api.service';
import type { Page } from '../../api/pagination.model';
import { TenantContextService } from '../../tenant-context/tenant-context.service';
import { EntityRecordsGateway } from '../data-access/entity-records.gateway';
import { DynamicEntityRegistryService } from '../entity-registry.service';
import type { EntityDefinition } from '../models/entity-definition.model';
import {
  type AuditChange,
  type AuditEntry,
  type CreateRecordInput,
  type EntityRecord,
  type RecordActions,
  type RecordQuery,
  type ReferenceLookupQuery,
  type ReferenceOption,
  type TransitionOptions,
  type UpdateRecordInput,
  USER_DIRECTORY_KEY,
} from '../models/entity-record.model';
import type { FieldValue } from '../models/field-definition.model';
import type { SemanticColor } from '../models/status.model';
import type { ActionsDto, AuditLogDto, RecordDto } from './dynamic-dto';
import { toRecordFailure } from './dynamic-errors';
import {
  entityCodeOf,
  fieldCodeOf,
  fieldKeyOf,
  fieldsByCode,
  recordDataFromServer,
  recordDataToServer,
} from './dynamic-mapper';

const SEMANTIC_COLORS: readonly SemanticColor[] = [
  'neutral',
  'brand',
  'success',
  'warning',
  'danger',
];
const CATEGORY_COLOR: Record<'INITIAL' | 'ACTIVE' | 'FINAL' | 'CANCELLED', SemanticColor> = {
  INITIAL: 'neutral',
  ACTIVE: 'brand',
  FINAL: 'success',
  CANCELLED: 'danger',
};

/** A cor do estado no servidor é um nome livre; só as cores semânticas da interface se usam (senão, a da categoria). */
const stateColor = (
  color: string | null,
  category: 'INITIAL' | 'ACTIVE' | 'FINAL' | 'CANCELLED',
): SemanticColor => SEMANTIC_COLORS.find((c) => c === color) ?? CATEGORY_COLOR[category];

const records = (entityKey: string) => `dynamic/${entityCodeOf(entityKey)}/records`;

/**
 * Registos de entidades dinâmicas sobre a API real (C10). O servidor valida (incl. unicidade), isola por
 * tenant, aplica permissões e campos sensíveis, audita e controla a concorrência. As transições de estado (C13) e as acções
 * disponíveis também são do servidor.
 */
@Injectable()
export class HttpEntityRecordsGateway extends EntityRecordsGateway {
  private readonly api = inject(ApiService);
  private readonly registry = inject(DynamicEntityRegistryService);
  private readonly tenantContext = inject(TenantContextService);

  list(entityKey: string, query: RecordQuery): Observable<Page<EntityRecord>> {
    const params: Record<string, string | number | boolean> = {
      limit: query.pageSize,
      offset: (query.page - 1) * query.pageSize,
    };
    if (query.search) params['q'] = query.search;
    if (query.sort) {
      const { key, direction } = query.sort;
      params['sort'] =
        `${key === 'createdAt' || key === 'updatedAt' ? key : fieldCodeOf(key)}:${direction}`;
    }
    for (const [key, value] of Object.entries(query.filters ?? {})) {
      // O estado ainda não existe no servidor (C13).
      if (key !== 'status') params[`filter.${fieldCodeOf(key)}`] = String(value);
    }
    return this.definition(entityKey).pipe(
      switchMap((entity) =>
        this.api.getWithMeta<readonly RecordDto[]>(records(entityKey), { params }).pipe(
          map(({ data, meta }) => ({
            items: data.map((r) => this.record(entity, r)),
            total: Number(meta['total'] ?? data.length),
            page: query.page,
            pageSize: query.pageSize,
          })),
        ),
      ),
    );
  }

  get(entityKey: string, id: string): Observable<EntityRecord> {
    return this.definition(entityKey).pipe(
      switchMap((entity) =>
        this.api
          .get<RecordDto>(`${records(entityKey)}/${id}`)
          .pipe(map((r) => this.record(entity, r))),
      ),
    );
  }

  create(entityKey: string, input: CreateRecordInput): Observable<EntityRecord> {
    return this.definition(entityKey).pipe(
      switchMap((entity) =>
        this.api
          .post<RecordDto>(records(entityKey), {
            data: recordDataToServer(input.data, entity.fields),
          })
          .pipe(map((r) => this.record(entity, r))),
      ),
      catchError((error: ApiError) => throwError(() => toRecordFailure(error))),
    );
  }

  update(entityKey: string, id: string, input: UpdateRecordInput): Observable<EntityRecord> {
    return this.definition(entityKey).pipe(
      switchMap((entity) =>
        this.api
          .patch<RecordDto>(`${records(entityKey)}/${id}`, {
            data: recordDataToServer(input.data, entity.fields),
            expectedVersion: input.expectedRowVersion,
          })
          .pipe(map((r) => this.record(entity, r))),
      ),
      catchError((error: ApiError) => throwError(() => toRecordFailure(error))),
    );
  }

  /** «Eliminar» arquiva: os dados nunca se apagam e o valor único fica livre. */
  delete(entityKey: string, id: string): Observable<void> {
    return this.api.get<RecordDto>(`${records(entityKey)}/${id}`).pipe(
      switchMap((current) =>
        this.api.post<RecordDto>(`${records(entityKey)}/${id}/archive`, {
          expectedVersion: current.version,
        }),
      ),
      map(() => undefined),
    );
  }

  /** As transições que o servidor deixa executar agora; um registo sem estado (sem máquina) devolve `null`. */
  availableActions(entityKey: string, id: string): Observable<RecordActions | null> {
    return this.api.get<ActionsDto>(`${records(entityKey)}/${id}/available-actions`).pipe(
      map((dto) => ({
        version: dto.state.version,
        actions: dto.actions.map((a) => ({
          code: a.code,
          label: a.label,
          toLabel: a.toLabel,
          reasonRequired: a.reasonRequired,
        })),
      })),
      catchError((error: ApiError) =>
        error.code === 'RECORD_WITHOUT_STATE' ? of(null) : throwError(() => error),
      ),
    );
  }

  /** Executa uma transição no servidor (com `expectedVersion`) e devolve o registo já no novo estado. */
  transition(
    entityKey: string,
    id: string,
    transitionKey: string,
    options?: TransitionOptions,
  ): Observable<EntityRecord> {
    if (!options) {
      return throwError(
        () =>
          ({
            status: 400,
            message: 'Uma transição precisa da versão do estado em que a interface a viu.',
          }) satisfies ApiError,
      );
    }
    return this.definition(entityKey).pipe(
      switchMap((entity) =>
        this.api
          .post<unknown>(`${records(entityKey)}/${id}/transitions/${transitionKey}`, {
            expectedVersion: options.expectedVersion,
            ...(options.reason ? { reason: options.reason } : {}),
          })
          .pipe(
            switchMap(() => this.api.get<RecordDto>(`${records(entityKey)}/${id}`)),
            map((dto) => this.record(entity, dto)),
          ),
      ),
    );
  }

  audit(entityKey: string, id: string): Observable<readonly AuditEntry[]> {
    return forkJoin([
      this.definition(entityKey),
      this.api.get<readonly AuditLogDto[]>('audit-logs', {
        params: { resourceType: 'dynamic_records', resourceId: id, limit: 100 },
      }),
      // Os nomes vêm do directório de membros (se o utilizador o puder ver).
      this.members(),
    ]).pipe(
      map(([entity, logs, members]) => {
        const names = new Map(members.map((m) => [m.id, m.displayName ?? m.email ?? m.id]));
        const tenantId = this.tenantContext.tenant()?.id ?? '';
        return logs
          .map((log) => ({ log, changes: changesOf(log) }))
          .filter(({ log, changes }) => changes.length > 0 || actionOf(log) !== 'update')
          .map(({ log, changes }) => ({
            id: log.id,
            entityKey: entity.key,
            recordId: id,
            tenantId,
            action: actionOf(log),
            actorId: log.actorMembershipId ?? '',
            actorName: names.get(log.actorMembershipId ?? '') ?? 'Utilizador',
            at: log.occurredAt,
            changes,
          }))
          .reverse();
      }),
    );
  }

  lookup(entityKey: string, query: ReferenceLookupQuery): Observable<readonly ReferenceOption[]> {
    if (entityKey === USER_DIRECTORY_KEY) return this.lookupUsers(query);
    return this.definition(entityKey).pipe(
      switchMap((entity) => {
        const label = (r: EntityRecord) => labelOf(entity, r);
        if (query.ids?.length) {
          return forkJoin(
            query.ids.map((id) =>
              this.get(entityKey, id).pipe(
                map((r) => ({ id: r.id, label: label(r) })),
                catchError(() => of(null)),
              ),
            ),
          ).pipe(map((options) => options.filter((o): o is ReferenceOption => o !== null)));
        }
        return this.list(entityKey, {
          page: 1,
          pageSize: 20,
          ...(query.search ? { search: query.search } : {}),
        }).pipe(map((page) => page.items.map((r) => ({ id: r.id, label: label(r) }))));
      }),
    );
  }

  // ------------------------------------------------------------------ interno

  private definition(entityKey: string): Observable<EntityDefinition> {
    return this.registry.ensureLoaded().pipe(
      map(() => {
        const entity = this.registry.find(entityKey);
        if (!entity) throw { status: 404, message: 'Entidade inexistente.' } satisfies ApiError;
        return entity;
      }),
    );
  }

  private record(entity: EntityDefinition, dto: RecordDto): EntityRecord {
    return {
      id: dto.id,
      entityKey: entity.key,
      tenantId: this.tenantContext.tenant()?.id ?? '',
      definitionVersion: dto.schemaVersion.revision,
      status: dto.state?.code ?? null,
      ...(dto.state
        ? {
            state: {
              code: dto.state.code,
              label: dto.state.label,
              color: stateColor(dto.state.color, dto.state.category),
              category: dto.state.category,
              editable: dto.state.editable,
              version: dto.state.version,
            },
          }
        : {}),
      data: recordDataFromServer(dto.data, fieldsByCode(entity.fields)),
      rowVersion: dto.version,
      createdAt: dto.createdAt,
      createdBy: dto.createdByMembershipId ?? '',
      updatedAt: dto.updatedAt,
      updatedBy: dto.updatedByMembershipId ?? '',
    };
  }

  private lookupUsers(query: ReferenceLookupQuery): Observable<readonly ReferenceOption[]> {
    return this.members().pipe(
      map((members) => {
        const needle = (query.search ?? '').trim().toLowerCase();
        return members
          .filter((m) => m.status === 'ACTIVE')
          .filter((m) => (query.ids ? query.ids.includes(m.id) : true))
          .map((m) => ({ id: m.id, label: m.displayName ?? m.email ?? m.id }))
          .filter((o) => !needle || o.label.toLowerCase().includes(needle));
      }),
    );
  }

  /** Membros do tenant; sem permissão para os ver a lista fica vazia (o servidor continua a validar o destino). */
  private members(): Observable<readonly MemberSummary[]> {
    return this.api.get<readonly MemberSummary[]>('memberships').pipe(catchError(() => of([])));
  }
}

interface MemberSummary {
  readonly id: string;
  readonly displayName: string | null;
  readonly email: string | null;
  readonly status: string;
}

function actionOf(log: AuditLogDto): AuditEntry['action'] {
  if (log.action.endsWith('INSERT')) return 'create';
  if (log.action.endsWith('DELETE')) return 'delete';
  return log.after?.['archivedAt'] && !log.before?.['archivedAt'] ? 'delete' : 'update';
}

/** Diferenças entre os valores antes e depois (a auditoria nunca contém os campos sensíveis). */
function changesOf(log: AuditLogDto): AuditChange[] {
  const before = (log.before?.['data'] ?? {}) as Record<string, unknown>;
  const after = (log.after?.['data'] ?? {}) as Record<string, unknown>;
  const codes = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...codes]
    .filter((code) => JSON.stringify(before[code]) !== JSON.stringify(after[code]))
    .map((code) => ({
      field: fieldKeyOf(code),
      from: before[code] as FieldValue | undefined,
      to: after[code] as FieldValue | undefined,
    }));
}

function labelOf(entity: EntityDefinition, record: EntityRecord): string {
  const first = entity.list.columns
    .map((c) => c.field)
    .find((key) => typeof record.data[key] === 'string' && record.data[key] !== '');
  const value = first ? record.data[first] : null;
  return typeof value === 'string' ? value : record.id;
}
