import { inject, Injectable } from '@angular/core';
import { map, type Observable, timer } from 'rxjs';
import type { ApiError } from '../api/api-error.model';
import type { Page } from '../api/pagination.model';
import { AuthService } from '../auth/auth.service';
import { EntityRecordsGateway } from '../dynamic/data-access/entity-records.gateway';
import { compareScalars, isEmptyValue } from '../dynamic/engine/condition';
import { evaluateOperation } from '../dynamic/engine/entity-permissions';
import { fieldAccessFromPermissions } from '../dynamic/engine/field-state';
import { formatFieldValue } from '../dynamic/engine/format-value';
import { resolvePublished } from '../dynamic/engine/resolve-definitions';
import { recordLabel } from '../dynamic/engine/record-label';
import { validateRecordData } from '../dynamic/engine/validation';
import { applyTransition, initialStatus } from '../dynamic/engine/workflow';
import type { EntityDefinition, EntityOperation } from '../dynamic/models/entity-definition.model';
import {
  type AuditChange,
  type AuditEntry,
  type CreateRecordInput,
  type EntityRecord,
  type RecordData,
  type RecordQuery,
  type ReferenceLookupQuery,
  type ReferenceOption,
  type UpdateRecordInput,
} from '../dynamic/models/entity-record.model';
import {
  hasOptions,
  type FieldDefinition,
  type FieldValue,
} from '../dynamic/models/field-definition.model';
import type {
  RecordValidationFailure,
  ValidationIssue,
} from '../dynamic/models/validation-issue.model';
import { TenantModulesService } from '../modules/tenant-modules.service';
import { PermissionService } from '../permissions/permission.service';
import { TenantContextService } from '../tenant-context/tenant-context.service';
import { MOCK_ENTITY_DEFINITIONS } from './mock-entities';
import { MOCK_ENTITY_RECORDS } from './mock-entity-records';
import { mockSettings } from './mock-helpers';

const fail = (status: number, message: string, details?: unknown): ApiError => ({
  status,
  message,
  details,
});
const unprocessable = (issues: readonly ValidationIssue[]): ApiError =>
  fail(422, 'Existem erros de validação.', { issues } satisfies RecordValidationFailure);

const normalize = (text: string): string =>
  text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .trim();

const MAX_LOOKUP = 50;

/**
 * Simula o **backend** dos registos dinâmicos (não o frontend): usa as suas próprias definições,
 * identifica o tenant e o utilizador pelo contexto do pedido, e aplica permissões (RBAC + ABAC),
 * validação (incluindo `unique` e referências), concorrência optimista e auditoria.
 * Os dados de cada tenant estão separados; um registo de outro tenant responde 404.
 */
@Injectable()
export class MockEntityRecordsGateway extends EntityRecordsGateway {
  private readonly tenantContext = inject(TenantContextService);
  private readonly auth = inject(AuthService);
  private readonly permissions = inject(PermissionService);
  private readonly modules = inject(TenantModulesService);

  private readonly records = new Map<string, EntityRecord[]>(); // `${tenantId}:${entityKey}`
  private readonly audits = new Map<string, AuditEntry[]>(); // `${tenantId}:${entityKey}:${id}`
  private counter = 0;

  constructor() {
    super();
    for (const record of MOCK_ENTITY_RECORDS) {
      this.bucket(record.tenantId, record.entityKey).push(record);
      this.pushAudit(record, 'create', []);
    }
  }

  // ------------------------------------------------------------------ contrato

  list(entityKey: string, query: RecordQuery): Observable<Page<EntityRecord>> {
    return this.respond(() => {
      const { tenantId, entity } = this.resolve(entityKey);
      this.require(entity, 'read');

      let items = [...this.bucket(tenantId, entityKey)];
      if (query.search?.trim()) {
        const needle = normalize(query.search);
        items = items.filter((r) =>
          entity.list.searchFields.some((k) => normalize(String(r.data[k] ?? '')).includes(needle)),
        );
      }
      for (const [key, value] of Object.entries(query.filters ?? {})) {
        items = items.filter((r) => this.matches(r, key, String(value)));
      }
      if (query.sort) items.sort(this.comparator(entity, query.sort.key, query.sort.direction));

      const start = (query.page - 1) * query.pageSize;
      return {
        items: items.slice(start, start + query.pageSize).map((r) => this.visible(entity, r)),
        total: items.length,
        page: query.page,
        pageSize: query.pageSize,
      };
    });
  }

  get(entityKey: string, id: string): Observable<EntityRecord> {
    return this.respond(() => {
      const { entity, record } = this.find(entityKey, id);
      this.require(entity, 'read', record);
      return this.visible(entity, record);
    });
  }

  create(entityKey: string, input: CreateRecordInput): Observable<EntityRecord> {
    return this.respond(() => {
      const { tenantId, entity } = this.resolve(entityKey);
      this.require(entity, 'create');

      const status = initialStatus(entity);
      this.validate(entity, tenantId, input.data, { mode: 'create', status, excludeId: null });

      const now = new Date().toISOString();
      const record: EntityRecord = {
        id: `${entityKey}-${this.nextId(tenantId, entityKey)}`,
        entityKey,
        tenantId,
        definitionVersion: entity.version,
        status,
        data: this.clean(entity, input.data),
        rowVersion: 1,
        createdAt: now,
        createdBy: this.actorId(),
        updatedAt: now,
        updatedBy: this.actorId(),
      };
      this.bucket(tenantId, entityKey).push(record);
      this.pushAudit(record, 'create', this.diff(entity, {}, record.data));
      return record;
    });
  }

  update(entityKey: string, id: string, input: UpdateRecordInput): Observable<EntityRecord> {
    return this.respond(() => {
      const { tenantId, entity, record } = this.find(entityKey, id);
      this.require(entity, 'update', record);

      if (input.expectedRowVersion !== record.rowVersion) {
        throw fail(
          409,
          'O registo foi alterado por outro utilizador. Recarregue e volte a tentar.',
        );
      }
      const merged = { ...record.data, ...input.data };
      this.validate(entity, tenantId, merged, {
        mode: 'edit',
        status: record.status,
        excludeId: id,
        changed: Object.keys(input.data),
      });

      const data = this.clean(entity, merged);
      const changes = this.diff(entity, record.data, data);
      if (changes.length === 0) return record;

      const updated: EntityRecord = {
        ...record,
        data,
        definitionVersion: entity.version,
        rowVersion: record.rowVersion + 1,
        updatedAt: new Date().toISOString(),
        updatedBy: this.actorId(),
      };
      this.replace(updated);
      this.pushAudit(updated, 'update', changes);
      return updated;
    });
  }

  delete(entityKey: string, id: string): Observable<void> {
    return this.respond(() => {
      const { tenantId, entity, record } = this.find(entityKey, id);
      this.require(entity, 'delete', record);
      const bucket = this.bucket(tenantId, entityKey);
      bucket.splice(bucket.indexOf(record), 1);
      this.pushAudit(record, 'delete', []);
    });
  }

  transition(entityKey: string, id: string, transitionKey: string): Observable<EntityRecord> {
    return this.respond(() => {
      const { entity, record } = this.find(entityKey, id);
      this.require(entity, 'read', record);

      const result = applyTransition(entity, record, transitionKey, {
        can: (p) => this.permissions.can(p),
      });
      if (!result.ok) {
        const forbidden =
          result.reason === 'permission' ||
          result.reason === 'approval' ||
          result.reason === 'policy';
        throw fail(forbidden ? 403 : 422, result.message);
      }

      const updated: EntityRecord = {
        ...record,
        status: result.status,
        data: result.data,
        rowVersion: record.rowVersion + 1,
        updatedAt: new Date().toISOString(),
        updatedBy: this.actorId(),
      };
      this.replace(updated);
      this.pushAudit(updated, 'transition', [
        { field: 'status', from: record.status, to: result.status },
        ...this.diff(entity, record.data, result.data),
      ]);
      return updated;
    });
  }

  audit(entityKey: string, id: string): Observable<readonly AuditEntry[]> {
    return this.respond(() => {
      const { tenantId, entity, record } = this.find(entityKey, id);
      this.require(entity, 'read', record);
      return [...(this.audits.get(`${tenantId}:${entityKey}:${id}`) ?? [])].reverse();
    });
  }

  lookup(entityKey: string, query: ReferenceLookupQuery): Observable<readonly ReferenceOption[]> {
    return this.respond(() => {
      const { tenantId, entity } = this.resolve(entityKey);
      this.require(entity, 'read');
      const needle = query.search ? normalize(query.search) : null;
      return this.bucket(tenantId, entityKey)
        .filter((r) => !query.ids || query.ids.includes(r.id))
        .map((r) => ({ id: r.id, label: recordLabel(entity, r) }))
        .filter((o) => !needle || normalize(o.label).includes(needle))
        .slice(0, MAX_LOOKUP);
    });
  }

  // ------------------------------------------------------------ "servidor" interno

  private respond<T>(produce: () => T): Observable<T> {
    return timer(mockSettings.latencyMs).pipe(map(produce));
  }

  /** O tenant vem do contexto do pedido, como o cabeçalho `X-Tenant-Id` num backend real. */
  private resolve(entityKey: string): { tenantId: string; entity: EntityDefinition } {
    const tenantId = this.tenantContext.tenant()?.id;
    if (!tenantId) throw fail(403, 'Sem tenant activo.');

    const entity = resolvePublished(MOCK_ENTITY_DEFINITIONS, tenantId).find(
      (d) => d.key === entityKey,
    );
    if (!entity || (entity.moduleId !== null && !this.modules.isAvailable(entity.moduleId))) {
      throw fail(404, 'Entidade não encontrada.');
    }
    return { tenantId, entity };
  }

  private find(entityKey: string, id: string) {
    const { tenantId, entity } = this.resolve(entityKey);
    const record = this.bucket(tenantId, entityKey).find((r) => r.id === id);
    // Um id de outro tenant é indistinguível de um id que não existe.
    if (!record) throw fail(404, 'Registo não encontrado.');
    return { tenantId, entity, record };
  }

  private require(
    entity: EntityDefinition,
    operation: EntityOperation,
    record?: EntityRecord,
  ): void {
    const check = evaluateOperation(entity, operation, (p) => this.permissions.can(p), record);
    if (!check.allowed) throw fail(403, check.message ?? 'Não tem permissão para esta operação.');
  }

  private bucket(tenantId: string, entityKey: string): EntityRecord[] {
    const key = `${tenantId}:${entityKey}`;
    let bucket = this.records.get(key);
    if (!bucket) this.records.set(key, (bucket = []));
    return bucket;
  }

  private replace(record: EntityRecord): void {
    const bucket = this.bucket(record.tenantId, record.entityKey);
    bucket[bucket.findIndex((r) => r.id === record.id)] = record;
  }

  private nextId(tenantId: string, entityKey: string): number {
    this.counter += 1;
    return this.bucket(tenantId, entityKey).length + 1000 + this.counter;
  }

  private actorId(): string {
    return this.auth.user()?.id ?? 'anonymous';
  }

  /** Remove os campos que o utilizador não pode ler. */
  private visible(entity: EntityDefinition, record: EntityRecord): EntityRecord {
    const access = fieldAccessFromPermissions((p) => this.permissions.can(p));
    const data = Object.fromEntries(
      Object.entries(record.data).filter(([key]) => {
        const field = entity.fields.find((f) => f.key === key);
        return !field || access.canRead(field);
      }),
    );
    return { ...record, data };
  }

  private clean(entity: EntityDefinition, data: RecordData): RecordData {
    const known = new Set(entity.fields.map((f) => f.key));
    return Object.fromEntries(
      Object.entries(data).filter(([k, v]) => known.has(k) && v !== undefined),
    );
  }

  private matches(record: EntityRecord, key: string, value: string): boolean {
    const actual = key === 'status' ? record.status : record.data[key];
    return Array.isArray(actual) ? actual.includes(value) : String(actual ?? '') === value;
  }

  private comparator(entity: EntityDefinition, key: string, direction: 'asc' | 'desc') {
    const factor = direction === 'asc' ? 1 : -1;
    const value = (r: EntityRecord): FieldValue | undefined =>
      key === 'status'
        ? r.status
        : key === 'createdAt'
          ? r.createdAt
          : key === 'updatedAt'
            ? r.updatedAt
            : r.data[key];
    const label = (r: EntityRecord) => {
      const field = entity.fields.find((f) => f.key === key);
      return field && hasOptions(field) ? formatFieldValue(field, value(r)) : value(r);
    };
    return (a: EntityRecord, b: EntityRecord): number => {
      const x = label(a);
      const y = label(b);
      if (isEmptyValue(x as FieldValue) && isEmptyValue(y as FieldValue)) return 0;
      if (isEmptyValue(x as FieldValue)) return 1; // vazios no fim, em qualquer sentido
      if (isEmptyValue(y as FieldValue)) return -1;
      if (typeof x === 'string' && typeof y === 'string')
        return factor * x.localeCompare(y, 'pt', { sensitivity: 'base' });
      return factor * (compareScalars(x, y) ?? 0);
    };
  }

  // ------------------------------------------------------------------ validação

  private validate(
    entity: EntityDefinition,
    tenantId: string,
    data: RecordData,
    options: {
      mode: 'create' | 'edit';
      status: string | null;
      excludeId: string | null;
      changed?: readonly string[];
    },
  ): void {
    const access = fieldAccessFromPermissions((p) => this.permissions.can(p));
    const fields = new Map(entity.fields.map((f) => [f.key, f]));
    const issues: ValidationIssue[] = [];
    const add = (fieldKey: string, rule: ValidationIssue['rule'], message: string) =>
      issues.push({ fieldKey, rule, message });

    // Regras declarativas executáveis (as mesmas do frontend).
    issues.push(
      ...validateRecordData(entity, data, { mode: options.mode, status: options.status, access }),
    );

    const written = options.changed ?? Object.keys(data);
    for (const key of written) {
      const field = fields.get(key);
      if (!field || field.archived) {
        add(key, 'server', 'Campo desconhecido.');
        continue;
      }
      if (!access.canWrite(field)) add(key, 'server', 'Sem permissão para editar este campo.');
      const value = data[key];
      if (value === null || value === undefined) continue;
      if (!this.hasValidType(field, value)) add(key, 'server', 'Valor inválido.');
      else if (
        field.type === 'reference' &&
        !this.bucket(tenantId, field.entityKey).some((r) => r.id === value)
      ) {
        add(key, 'server', 'A referência não existe.');
      }
    }

    // Regras que só o servidor decide.
    for (const field of entity.fields) {
      const unique = field.validations.find((r) => r.type === 'unique');
      const value = data[field.key];
      if (!unique || typeof value !== 'string' || value.trim() === '') continue;
      const clash = this.bucket(tenantId, entity.key).some(
        (r) =>
          r.id !== options.excludeId &&
          normalize(String(r.data[field.key] ?? '')) === normalize(value),
      );
      if (clash) add(field.key, 'unique', unique.message ?? 'Já existe um registo com este valor.');
    }

    if (issues.length > 0) throw unprocessable(issues);
  }

  private hasValidType(field: FieldDefinition, value: FieldValue): boolean {
    switch (field.type) {
      case 'number':
      case 'decimal':
      case 'currency':
        return typeof value === 'number' && Number.isFinite(value);
      case 'boolean':
        return typeof value === 'boolean';
      case 'multiselect':
        return (
          Array.isArray(value) &&
          (value as readonly unknown[]).every((v) => field.options.some((o) => o.value === v))
        );
      case 'select':
        return typeof value === 'string' && field.options.some((o) => o.value === value);
      case 'file':
        return Array.isArray(value);
      default:
        return typeof value === 'string';
    }
  }

  // ------------------------------------------------------------------ auditoria

  private diff(entity: EntityDefinition, before: RecordData, after: RecordData): AuditChange[] {
    if (!entity.audit.enabled) return [];
    const tracked =
      entity.audit.trackedFields === 'all'
        ? entity.fields.map((f) => f.key)
        : entity.audit.trackedFields;
    return tracked
      .filter((k) => JSON.stringify(before[k] ?? null) !== JSON.stringify(after[k] ?? null))
      .map((k) => ({ field: k, from: before[k] ?? null, to: after[k] ?? null }));
  }

  private pushAudit(
    record: EntityRecord,
    action: AuditEntry['action'],
    changes: readonly AuditChange[],
  ): void {
    const key = `${record.tenantId}:${record.entityKey}:${record.id}`;
    const entries = this.audits.get(key) ?? [];
    const user = this.auth.user();
    entries.push({
      id: `${key}#${entries.length + 1}`,
      entityKey: record.entityKey,
      recordId: record.id,
      tenantId: record.tenantId,
      action,
      actorId: user?.id ?? record.updatedBy,
      actorName: user?.name ?? 'Sistema',
      at: record.updatedAt,
      changes,
    });
    this.audits.set(key, entries);
  }
}
