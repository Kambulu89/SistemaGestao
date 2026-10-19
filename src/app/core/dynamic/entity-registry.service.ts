import { computed, effect, inject, Injectable, signal } from '@angular/core';
import { type Observable, of, tap } from 'rxjs';
import { AuthService } from '../auth/auth.service';
import { TenantContextService } from '../tenant-context/tenant-context.service';
import { EntityDefinitionGateway } from './data-access/entity-definition.gateway';
import { type DefinitionIssue, validateEntityDefinition } from './engine/definition-integrity';
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

  private readonly loaded = signal<LoadedDefinitions | null>(null);

  /** Todas as versões e estados (rascunhos e arquivadas incluídos) visíveis ao tenant activo. */
  readonly all = computed<readonly EntityDefinition[]>(() => {
    const tenant = this.tenantContext.tenant();
    const loaded = this.loaded();
    if (!tenant || loaded?.tenantId !== tenant.id) return [];
    return loaded.definitions.filter((d) => d.scope === 'global' || d.tenantId === tenant.id);
  });

  /** A definição em vigor de cada entidade (a versão publicada mais alta). */
  readonly published = computed<readonly EntityDefinition[]>(() => {
    const tenant = this.tenantContext.tenant();
    return tenant ? resolvePublished(this.all(), tenant.id) : [];
  });

  /** Problemas de integridade (inclui referências entre entidades) por chave de entidade. */
  readonly issues = computed<ReadonlyMap<string, readonly DefinitionIssue[]>>(() => {
    const known = new Set(this.published().map((d) => d.key));
    return new Map(
      this.published().map((d) => [d.key, validateEntityDefinition(d, { knownEntityKeys: known })]),
    );
  });

  constructor() {
    effect(() => {
      if (!this.auth.isAuthenticated()) this.loaded.set(null);
    });
  }

  /** Carrega as definições do tenant activo (uma vez por tenant). */
  ensureLoaded(): Observable<readonly EntityDefinition[]> {
    const tenant = this.tenantContext.tenant();
    if (!tenant) return of([]);
    const loaded = this.loaded();
    if (loaded?.tenantId === tenant.id) return of(loaded.definitions);

    return this.gateway
      .list()
      .pipe(tap((definitions) => this.loaded.set({ tenantId: tenant.id, definitions })));
  }

  reload(): void {
    this.loaded.set(null);
  }

  find(key: string): EntityDefinition | undefined {
    return this.published().find((d) => d.key === key);
  }

  versionsOf(key: string): readonly EntityDefinition[] {
    const tenant = this.tenantContext.tenant();
    return tenant ? versionsOf(this.all(), key, tenant.id) : [];
  }
}
