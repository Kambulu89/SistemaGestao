import { inject, Injectable } from '@angular/core';
import { type Observable } from 'rxjs';
import type { ApiError } from '../api/api-error.model';
import { AuthService } from '../auth/auth.service';
import type { DefinitionFailure } from '../dynamic/data-access/custom-field.gateway';
import {
  EntityDefinitionGateway,
  type SaveEntityDraftInput,
} from '../dynamic/data-access/entity-definition.gateway';
import { checkPublishable } from '../dynamic/engine/definition-compat';
import type { DefinitionIssue } from '../dynamic/engine/definition-integrity';
import { ENTITY_KEY_PATTERN } from '../dynamic/engine/field-draft';
import { defineEntity, generateDefaultList } from '../dynamic/engine/define-entity';
import type { EntityDefinition } from '../dynamic/models/entity-definition.model';
import { moduleId } from '../modules/define-module';
import { PermissionService } from '../permissions/permission.service';
import { TenantContextService } from '../tenant-context/tenant-context.service';
import { mockError, respond } from './mock-helpers';
import { MockMetadataStore } from './mock-metadata-store';

const MANAGE = 'configuration.forms.manage';
const PUBLISH = 'configuration.forms.publish';

const unprocessable = (message: string, issues: readonly DefinitionIssue[]): ApiError => ({
  status: 422,
  message,
  details: { issues } satisfies DefinitionFailure,
});
const error = (path: string, message: string): DefinitionIssue => ({
  severity: 'error',
  path,
  message,
});

/**
 * Simula o **backend** das definições: filtra por tenant a partir do contexto do pedido e é a
 * autoridade sobre criar, publicar e descartar entidades (permissão, integridade e versões).
 */
@Injectable()
export class MockEntityDefinitionGateway extends EntityDefinitionGateway {
  private readonly tenantContext = inject(TenantContextService);
  private readonly permissions = inject(PermissionService);
  private readonly auth = inject(AuthService);
  private readonly store = inject(MockMetadataStore);

  list(): Observable<readonly EntityDefinition[]> {
    return respond(() => this.store.definitionsFor(this.tenantId()));
  }

  saveDraft(input: SaveEntityDraftInput): Observable<EntityDefinition> {
    return respond(() => {
      const tenantId = this.tenantId();
      this.requireManage();

      const issues: DefinitionIssue[] = [];
      if (!ENTITY_KEY_PATTERN.test(input.key))
        issues.push(
          error('key', 'O código começa por minúscula e tem 2 a 30 minúsculas, números ou hífens.'),
        );
      if (!input.names.singular.trim() || !input.names.plural.trim())
        issues.push(error('names', 'Indique o nome no singular e no plural.'));

      const versions = this.store.versionsFor(tenantId, input.key);
      const mine = versions.filter((d) => d.scope === 'tenant');
      const global = versions.find((d) => d.scope === 'global');
      if (global)
        issues.push(error('key', `O código "${input.key}" pertence a uma entidade da plataforma.`));
      if (issues.length > 0) throw unprocessable('A entidade não é válida.', issues);

      const draft = mine.find((d) => d.state === 'draft');
      const published = mine.find((d) => d.state === 'published');
      const current = draft ?? published;
      if ((current?.version ?? null) !== input.expectedVersion) {
        throw mockError(409, 'A entidade foi alterada entretanto. Recarregue e volte a tentar.');
      }

      const version =
        draft?.version ?? (mine.length > 0 ? Math.max(...mine.map((d) => d.version)) + 1 : 1);
      const now = new Date().toISOString();
      const actor = this.auth.user()?.id ?? 'anonymous';
      const meta = {
        createdAt: current?.meta?.createdAt ?? now,
        createdBy: current?.meta?.createdBy ?? actor,
        updatedAt: now,
        updatedBy: actor,
      };
      const fields = input.fields.map((f, index) => ({ ...f, order: (index + 1) * 10 }));

      const base = current ?? null;
      // Listagem gerada automaticamente acompanha os campos; uma personalizada só perde o que sumiu.
      const auto =
        !!base &&
        JSON.stringify(base.list) ===
          JSON.stringify(generateDefaultList(base.fields, base.statuses.length > 0));
      const saved: EntityDefinition = base
        ? this.reconcile({
            ...base,
            id: `${input.key}@${tenantId}:v${version}`,
            version,
            state: 'draft',
            names: input.names,
            description: input.description,
            icon: input.icon,
            fields,
            list: auto ? generateDefaultList(fields, base.statuses.length > 0) : base.list,
            publishedAt: undefined,
            meta,
          })
        : defineEntity({
            key: input.key,
            scope: 'tenant',
            tenantId,
            moduleId: moduleId('configuration.forms'),
            version,
            state: 'draft',
            names: input.names,
            description: input.description,
            icon: input.icon,
            fields,
            meta,
          });
      return this.store.saveDefinition(saved);
    });
  }

  publish(key: string): Observable<EntityDefinition> {
    return respond(() => {
      const tenantId = this.tenantId();
      this.requireManage();
      if (!this.permissions.can(PUBLISH))
        throw mockError(403, 'Não tem permissão para publicar entidades.');
      const mine = this.store.versionsFor(tenantId, key).filter((d) => d.scope === 'tenant');
      const draft = mine.find((d) => d.state === 'draft');
      if (!draft) throw mockError(404, 'Não há rascunho para publicar.');
      const published = mine.find((d) => d.state === 'published') ?? null;

      const known = new Set(this.store.baseDefinitions(tenantId).map((d) => d.key));
      known.add(key);
      const check = checkPublishable(published, draft, { knownEntityKeys: known });
      const blocking = [
        ...check.issues.filter((i) => i.severity === 'error'),
        ...check.breaking.map((c) => error(c.path, c.message)),
      ];
      if (blocking.length > 0) throw unprocessable('O rascunho não pode ser publicado.', blocking);

      if (published) this.store.saveDefinition({ ...published, state: 'archived' });
      return this.store.saveDefinition({
        ...draft,
        state: 'published',
        publishedAt: new Date().toISOString(),
      });
    });
  }

  discardDraft(key: string): Observable<void> {
    return respond(() => {
      const tenantId = this.tenantId();
      this.requireManage();
      const draft = this.store
        .versionsFor(tenantId, key)
        .find((d) => d.scope === 'tenant' && d.state === 'draft');
      if (!draft) throw mockError(404, 'Não há rascunho para descartar.');
      this.store.removeDefinition(draft.id);
    });
  }

  // ------------------------------------------------------------------ interno

  private tenantId(): string {
    const id = this.tenantContext.tenant()?.id;
    if (!id) throw mockError(403, 'Sem tenant activo.');
    return id;
  }

  private requireManage(): void {
    if (!this.permissions.can(MANAGE))
      throw mockError(403, 'Não tem permissão para gerir entidades.');
  }

  /** Retira da listagem os campos que já não existem (colunas, pesquisa e filtros). */
  private reconcile(entity: EntityDefinition): EntityDefinition {
    const keys = new Set([
      ...entity.fields.filter((f) => !f.archived).map((f) => f.key),
      'status',
      'createdAt',
      'updatedAt',
    ]);
    const list = entity.list;
    return {
      ...entity,
      list: {
        ...list,
        columns: list.columns.filter((c) => keys.has(c.field)),
        searchFields: list.searchFields.filter((k) => keys.has(k)),
        filters: list.filters.filter((k) => keys.has(k)),
        defaultSort: list.defaultSort && keys.has(list.defaultSort.field) ? list.defaultSort : null,
      },
    };
  }
}
