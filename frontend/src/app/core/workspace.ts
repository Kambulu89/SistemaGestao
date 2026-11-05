import { Injectable, computed, inject, signal } from '@angular/core';
import { Api } from './api';

export interface TenantContextView {
  tenant: {
    id: string;
    code: string;
    name: string;
    countryCode: string;
    defaultCurrency: string;
    locale: string;
    timezone: string;
  };
  membershipId: string;
  subscriptionStatus: string;
  features: { code: string; limit: number | null }[];
}

const KEY = 'sg.tenantId';

/**
 * Empresa em contexto. O id escolhido é só um selector enviado em `X-Tenant-Id`: o servidor valida a membership e
 * devolve o contexto, as permissões efectivas e as funcionalidades activas (que só servem para esconder o que não se pode
 * usar; a API verifica cada pedido).
 */
@Injectable({ providedIn: 'root' })
export class Workspace {
  private readonly api = inject(Api);
  readonly tenantId = signal<string | null>(readStored());
  readonly context = signal<TenantContextView | null>(null);
  readonly permissions = signal<ReadonlySet<string>>(new Set());
  readonly features = computed(() => new Set((this.context()?.features ?? []).map((f) => f.code)));

  can(permission: string) {
    return this.permissions().has(permission);
  }

  has(feature: string) {
    return this.features().has(feature);
  }

  /** Selecciona e carrega a empresa; em erro (sem acesso) limpa a escolha e propaga. */
  async select(tenantId: string) {
    this.tenantId.set(tenantId);
    try {
      const [context, permissions] = await Promise.all([
        this.api.get<TenantContextView>('context'),
        this.api.get<{ tenant: string[] }>('me/permissions'),
      ]);
      this.context.set(context);
      this.permissions.set(new Set(permissions.tenant));
      store(tenantId);
    } catch (error) {
      this.reset();
      throw error;
    }
  }

  /** Recarrega permissões e funcionalidades (ex.: depois de alterar perfis). */
  async refresh() {
    const id = this.tenantId();
    if (id) await this.select(id);
  }

  reset() {
    this.tenantId.set(null);
    this.context.set(null);
    this.permissions.set(new Set());
    store(null);
  }
}

function readStored(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

function store(value: string | null) {
  try {
    if (value) localStorage.setItem(KEY, value);
    else localStorage.removeItem(KEY);
  } catch {
    /* armazenamento indisponível: a escolha não persiste */
  }
}
