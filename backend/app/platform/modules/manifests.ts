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
]

/** Activadores por módulo (sementes e configuração inicial do tenant). Idempotentes; vazio até haver módulos. */
export const MODULE_ACTIVATORS: Readonly<
  Record<string, (context: TenantContext) => Promise<void>>
> = {}
