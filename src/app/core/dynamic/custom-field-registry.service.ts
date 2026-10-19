import { computed, effect, inject, Injectable, signal } from '@angular/core';
import { type Observable, of, tap } from 'rxjs';
import { AuthService } from '../auth/auth.service';
import { TenantContextService } from '../tenant-context/tenant-context.service';
import { CustomFieldGateway } from './data-access/custom-field.gateway';
import {
  type CustomFieldDefinition,
  type EntityRef,
  entityRefId,
} from './models/custom-definition.model';

interface LoadedCustomFields {
  readonly tenantId: string;
  readonly definitions: readonly CustomFieldDefinition[];
}

/**
 * Definições (em bruto) dos campos personalizados do tenant activo. Não conhece as entidades:
 * quem as funde nas definições nativas é o `DynamicEntityRegistryService`. Os dados ficam
 * associados ao tenant com que foram carregados e nunca se misturam ao trocar de tenant.
 */
@Injectable({ providedIn: 'root' })
export class CustomFieldRegistryService {
  private readonly gateway = inject(CustomFieldGateway);
  private readonly tenantContext = inject(TenantContextService);
  private readonly auth = inject(AuthService);

  private readonly loaded = signal<LoadedCustomFields | null>(null);

  /** Todos os estados, só do tenant activo (mesmo que o servidor devolva mais). */
  readonly all = computed<readonly CustomFieldDefinition[]>(() => {
    const tenant = this.tenantContext.tenant();
    const loaded = this.loaded();
    if (!tenant || loaded?.tenantId !== tenant.id) return [];
    return loaded.definitions.filter((d) => d.tenantId === tenant.id);
  });

  constructor() {
    effect(() => {
      if (!this.auth.isAuthenticated()) this.loaded.set(null);
    });
  }

  ensureLoaded(): Observable<readonly CustomFieldDefinition[]> {
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

  /** Substitui (ou acrescenta) uma definição já gravada, sem voltar a pedir a lista. */
  upsert(definition: CustomFieldDefinition): void {
    const tenant = this.tenantContext.tenant();
    const loaded = this.loaded();
    if (!tenant || loaded?.tenantId !== tenant.id || definition.tenantId !== tenant.id) return;
    const rest = loaded.definitions.filter((d) => d.id !== definition.id);
    this.loaded.set({ tenantId: tenant.id, definitions: [...rest, definition] });
  }

  /** Campos personalizados de uma entidade, de qualquer estado, pela ordem de apresentação. */
  forEntity(ref: EntityRef): readonly CustomFieldDefinition[] {
    const id = entityRefId(ref);
    return this.all()
      .filter((d) => entityRefId(d.entity) === id)
      .sort((a, b) => a.displayOrder - b.displayOrder || a.id.localeCompare(b.id));
  }
}
