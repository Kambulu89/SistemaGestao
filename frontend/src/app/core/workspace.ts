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
  /**
   * Âmbito de trabalho escolhido na barra superior (entidade legal e filial), guardado por empresa. É só um filtro por
   * omissão das listas e um valor por omissão nos formulários; não dá nem retira acesso.
   */
  readonly legalEntityId = signal<string | null>(null);
  readonly branchId = signal<string | null>(null);
  /** Cache por empresa (ex.: nomes de registos para listas); limpa sempre que a empresa muda. */
  private cache = new Map<string, Promise<unknown>>();

  /** Valor em cache para esta empresa; a função só corre na primeira vez (um erro não fica em cache). */
  cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    const scopedKey = `${this.tenantId()}:${key}`;
    if (!this.cache.has(scopedKey)) {
      const promise = load().catch((error) => {
        this.cache.delete(scopedKey);
        throw error;
      });
      this.cache.set(scopedKey, promise);
    }
    return this.cache.get(scopedKey) as Promise<T>;
  }

  invalidate(prefix = '') {
    for (const key of [...this.cache.keys()])
      if (key.startsWith(`${this.tenantId()}:${prefix}`)) this.cache.delete(key);
  }

  setScope(legalEntityId: string | null, branchId: string | null = null) {
    this.legalEntityId.set(legalEntityId);
    this.branchId.set(legalEntityId ? branchId : null);
    const id = this.tenantId();
    if (id) {
      writeKey(
        `sg.scope.${id}`,
        JSON.stringify({ legalEntityId, branchId: legalEntityId ? branchId : null }),
      );
    }
  }

  can(permission: string) {
    return this.permissions().has(permission);
  }

  has(feature: string) {
    return this.features().has(feature);
  }

  /** Selecciona e carrega a empresa; em erro (sem acesso) limpa a escolha e propaga. */
  async select(tenantId: string) {
    if (tenantId !== this.tenantId()) this.clearTenantState();
    this.tenantId.set(tenantId);
    try {
      const [context, permissions] = await Promise.all([
        this.api.get<TenantContextView>('context'),
        this.api.get<{ tenant: string[] }>('me/permissions'),
      ]);
      this.context.set(context);
      this.permissions.set(new Set(permissions.tenant));
      store(tenantId);
      const scope = parseScope(readKey(`sg.scope.${tenantId}`));
      this.legalEntityId.set(scope.legalEntityId);
      this.branchId.set(scope.branchId);
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
    this.clearTenantState();
    this.tenantId.set(null);
    store(null);
  }

  /** Esquece tudo o que pertence à empresa actual (contexto, permissões, âmbito e cache). */
  private clearTenantState() {
    this.context.set(null);
    this.permissions.set(new Set());
    this.legalEntityId.set(null);
    this.branchId.set(null);
    this.cache = new Map();
  }
}

function readStored(): string | null {
  return readKey(KEY);
}

function readKey(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeKey(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* sem armazenamento: o âmbito não persiste */
  }
}

function parseScope(raw: string | null): { legalEntityId: string | null; branchId: string | null } {
  try {
    const value = raw ? JSON.parse(raw) : null;
    return {
      legalEntityId: typeof value?.legalEntityId === 'string' ? value.legalEntityId : null,
      branchId: typeof value?.branchId === 'string' ? value.branchId : null,
    };
  } catch {
    return { legalEntityId: null, branchId: null };
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
