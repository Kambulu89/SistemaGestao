import type { TenantContext } from '#core/tenancy/index'
import type { ModuleManifest } from '#platform/modules/domain/module'

/**
 * Manifestos **entregues por código** (C03). Cada módulo de negócio acrescenta aqui o seu manifesto quando
 * existir no backend; nunca se regista um módulo que ainda não foi implementado. O tenant não define
 * manifestos nem SQL: só activa o que o registo contém.
 */
export const CODE_MANIFESTS: readonly ModuleManifest[] = [
  {
    code: 'core',
    name: 'Núcleo da plataforma',
    kind: 'FOUNDATION',
    releaseVersion: '0.3.0',
    minCoreVersion: '0.3.0',
    dependencies: [],
    features: [],
  },
  {
    code: 'catalog',
    name: 'Catálogo e preços',
    kind: 'MODULE',
    releaseVersion: '0.1.0',
    minCoreVersion: '0.3.0',
    dependencies: [{ code: 'core', constraint: '*', optional: false }],
    features: [
      { code: 'catalog.products', name: 'Produtos, variantes e categorias', defaultEnabled: true },
      { code: 'catalog.prices', name: 'Tabelas de preços', defaultEnabled: true },
    ],
  },
  {
    code: 'customers',
    name: 'Clientes',
    kind: 'MODULE',
    releaseVersion: '0.1.0',
    minCoreVersion: '0.3.0',
    dependencies: [{ code: 'core', constraint: '*', optional: false }],
    features: [
      { code: 'customers.accounts', name: 'Clientes e segmentos', defaultEnabled: true },
      { code: 'customers.interactions', name: 'Interacções comerciais', defaultEnabled: true },
    ],
  },
  {
    code: 'orders',
    name: 'Propostas e encomendas',
    kind: 'MODULE',
    releaseVersion: '0.1.0',
    minCoreVersion: '0.3.0',
    dependencies: [
      { code: 'core', constraint: '*', optional: false },
      { code: 'catalog', constraint: '*', optional: false },
      { code: 'customers', constraint: '*', optional: false },
    ],
    features: [
      { code: 'orders.quotes', name: 'Propostas comerciais', defaultEnabled: true },
      { code: 'orders.orders', name: 'Encomendas de venda', defaultEnabled: true },
    ],
  },
  {
    code: 'inventory',
    name: 'Inventário',
    kind: 'MODULE',
    releaseVersion: '0.1.0',
    minCoreVersion: '0.3.0',
    dependencies: [
      { code: 'core', constraint: '*', optional: false },
      { code: 'catalog', constraint: '*', optional: false },
    ],
    features: [
      { code: 'inventory.warehouses', name: 'Armazéns e locais', defaultEnabled: true },
      {
        code: 'inventory.stock',
        name: 'Stock, movimentos, lotes e reservas',
        defaultEnabled: true,
      },
    ],
  },
]

/** Activadores por módulo (sementes e configuração inicial do tenant). Idempotentes; vazio até haver módulos. */
export const MODULE_ACTIVATORS: Readonly<
  Record<string, (context: TenantContext) => Promise<void>>
> = {}
