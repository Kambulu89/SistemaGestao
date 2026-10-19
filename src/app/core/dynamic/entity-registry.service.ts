import { computed, effect, inject, Injectable, signal } from '@angular/core';
import { forkJoin, map, type Observable, of, tap } from 'rxjs';
import { AuthService } from '../auth/auth.service';
import { TenantContextService } from '../tenant-context/tenant-context.service';
import { CustomFieldRegistryService } from './custom-field-registry.service';
import {
  EntityDefinitionGateway,
  type SaveEntityDraftInput,
} from './data-access/entity-definition.gateway';
import {
  mergeCustomFieldsDetailed,
  validateCustomFieldDefinition,
  type SkippedCustomField,
} from './engine/custom-fields';
import {
  type DefinitionIssue,
  integrityContext,
  validateEntityDefinition,
} from './engine/definition-integrity';
import { resolveLookupSources } from './engine/lookup-source';
import { resolvePublished, versionsOf } from './engine/resolve-definitions';
import type { EntityDefinition } from './models/entity-definition.model';

interface LoadedDefinitions {
  readonly tenantId: string;
  readonly definitions: readonly EntityDefinition[];
}

/**
 * Registo de entidades dinâmicas do tenant activo. Não duplica o Module Registry: este diz que
 * módulos existem; aquele diz que entidades configuráveis o tenant tem (globais e próprias).
 * Os dados ficam associados ao tenant com que foram carregados: trocar de tenant nunca os mistura.
 */
@Injectable({ providedIn: 'root' })
export class DynamicEntityRegistryService {
  private readonly gateway = inject(EntityDefinitionGateway);
  private readonly tenantContext = inject(TenantContextService);
  private readonly auth = inject(AuthService);
  private readonly customFields = inject(CustomFieldRegistryService);

  private readonly loaded = signal<LoadedDefinitions | null>(null);

  /** Todas as versões e estados (rascunhos e arquivadas incluídos) visíveis ao tenant activo. */
  readonly all = computed<readonly EntityDefinition[]>(() => {
    const tenant = this.tenantContext.tenant();
    const loaded = this.loaded();
    if (!tenant || loaded?.tenantId !== tenant.id) return [];
    return loaded.definitions.filter((d) => d.scope === 'global' || d.tenantId === tenant.id);
  });

  /** A definição em vigor de cada entidade, sem campos personalizados (como a plataforma a define). */
  readonly base = computed<readonly EntityDefinition[]>(() => {
    const tenant = this.tenantContext.tenant();
    return tenant ? resolvePublished(this.all(), tenant.id) : [];
  });

  private readonly merged = computed(() => {
    const tenant = this.tenantContext.tenant();
    const custom = this.customFields.all();
    return this.base().map((d) =>
      tenant ? mergeCustomFieldsDetailed(d, custom, tenant.id) : { entity: d, skipped: [] },
    );
  });

  /**
   * A definição em vigor de cada entidade, **já com os campos personalizados do tenant**.
   * Os renderers e motores recebem esta e não precisam de saber o que é personalizado.
   */
  readonly published = computed<readonly EntityDefinition[]>(() =>
    resolveLookupSources(this.merged().map((m) => m.entity)),
  );

  /** Campos personalizados que não foram fundidos (ex.: código em conflito), por entidade. */
  readonly skippedCustomFields = computed<ReadonlyMap<string, readonly SkippedCustomField[]>>(
    () =>
      new Map(
        this.merged()
          .filter((m) => m.skipped.length > 0)
          .map((m) => [m.entity.key, m.skipped]),
      ),
  );

  /** Problemas das definições dos campos personalizados, por entidade. */
  readonly customFieldIssues = computed<ReadonlyMap<string, readonly DefinitionIssue[]>>(() => {
    const all = this.customFields.all();
    const context = integrityContext(this.published());
    const result = new Map<string, DefinitionIssue[]>();
    for (const def of all) {
      if (def.state === 'archived') continue;
      const entity = this.base().find((d) => d.key === def.entity.key);
      const issues = validateCustomFieldDefinition(entity, def, all, context);
      if (issues.length > 0)
        result.set(def.entity.key, [...(result.get(def.entity.key) ?? []), ...issues]);
    }
    return result;
  });

  /** Problemas de integridade (inclui referências entre entidades) por chave de entidade. */
  readonly issues = computed<ReadonlyMap<string, readonly DefinitionIssue[]>>(() => {
    const context = integrityContext(this.published());
    return new Map(this.published().map((d) => [d.key, validateEntityDefinition(d, context)]));
  });

  constructor() {
    effect(() => {
      if (!this.auth.isAuthenticated()) this.loaded.set(null);
    });
  }

  /** Carrega as definições e os campos personalizados do tenant activo (uma vez por tenant). */
  ensureLoaded(): Observable<readonly EntityDefinition[]> {
    const tenant = this.tenantContext.tenant();
    if (!tenant) return of([]);
    const loaded = this.loaded();
    const definitions$ =
      loaded?.tenantId === tenant.id
        ? of(loaded.definitions)
        : this.gateway
            .list()
            .pipe(tap((definitions) => this.loaded.set({ tenantId: tenant.id, definitions })));

    return forkJoin([definitions$, this.customFields.ensureLoaded()]).pipe(
      map(([definitions]) => definitions),
    );
  }

  /** Guarda o rascunho de uma entidade do tenant e actualiza o registo. */
  saveDraft(input: SaveEntityDraftInput): Observable<EntityDefinition> {
    return this.gateway.saveDraft(input).pipe(tap((saved) => this.replace(saved)));
  }

  /** Publica o rascunho: a versão anterior fica arquivada. */
  publish(key: string): Observable<EntityDefinition> {
    return this.gateway
      .publish(key)
      .pipe(
        tap((published) =>
          this.replace(published, (d) =>
            d.key === key && d.state === 'published' && d.id !== published.id
              ? { ...d, state: 'archived' }
              : d,
          ),
        ),
      );
  }

  discardDraft(key: string): Observable<void> {
    return this.gateway.discardDraft(key).pipe(
      tap(() => {
        const tenant = this.tenantContext.tenant();
        const loaded = this.loaded();
        if (!tenant || loaded?.tenantId !== tenant.id) return;
        this.loaded.set({
          tenantId: tenant.id,
          definitions: loaded.definitions.filter(
            (d) => !(d.key === key && d.scope === 'tenant' && d.state === 'draft'),
          ),
        });
      }),
    );
  }

  /** A versão em rascunho de uma entidade do tenant, se existir. */
  draftOf(key: string): EntityDefinition | undefined {
    return this.all().find((d) => d.key === key && d.scope === 'tenant' && d.state === 'draft');
  }

  private replace(
    saved: EntityDefinition,
    adjust: (d: EntityDefinition) => EntityDefinition = (d) => d,
  ): void {
    const tenant = this.tenantContext.tenant();
    const loaded = this.loaded();
    if (!tenant || loaded?.tenantId !== tenant.id || saved.tenantId !== tenant.id) return;
    const rest = loaded.definitions.filter((d) => d.id !== saved.id).map(adjust);
    this.loaded.set({ tenantId: tenant.id, definitions: [...rest, saved] });
  }

  reload(): void {
    this.loaded.set(null);
    this.customFields.reload();
  }

  find(key: string): EntityDefinition | undefined {
    return this.published().find((d) => d.key === key);
  }

  versionsOf(key: string): readonly EntityDefinition[] {
    const tenant = this.tenantContext.tenant();
    return tenant ? versionsOf(this.all(), key, tenant.id) : [];
  }
}
