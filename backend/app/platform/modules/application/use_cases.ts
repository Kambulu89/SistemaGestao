import { ApiError } from '#core/http/api_error'
import type { TenantContext, TenantScope, TenantUnitOfWork } from '#core/tenancy/index'
import {
  RegistryError,
  activeDependents,
  decideFeature,
  missingDependencies,
  validateManifests,
  type ModuleManifest,
  type RegistryModule,
  type TenantModuleStatus,
} from '#platform/modules/domain/module'
import type {
  Clock,
  Licence,
  LicenceReader,
  ModuleActivator,
  RegistryStore,
  TenantModuleStore,
} from '#platform/modules/application/ports'

const systemClock: Clock = { now: () => new Date() }

/** Valida o conjunto completo de manifestos (ciclos, dependências, versões) e só então grava. */
export class SyncRegistry {
  constructor(private readonly store: RegistryStore) {}

  async execute(manifests: readonly ModuleManifest[]) {
    try {
      validateManifests(manifests)
    } catch (error) {
      if (error instanceof RegistryError) {
        throw new ApiError(422, 'VALIDATION_ERROR', 'Registo de módulos inválido.', [
          { path: 'manifests', code: error.code, message: error.message },
        ])
      }
      throw error
    }
    return this.store.sync(manifests)
  }
}

// --- estado do tenant ---------------------------------------------------------------------------

export interface FeatureView {
  code: string
  name: string
  moduleCode: string
  enabled: boolean
  reason: string | null
  /** O que o tenant configurou, para a interface de administração. */
  override: boolean | null
  overrideReason: string | null
  overrideExpiresAt: Date | null
}

export interface ModuleView {
  code: string
  name: string
  kind: RegistryModule['kind']
  releaseVersion: string
  registryStatus: RegistryModule['status']
  requires: RegistryModule['dependencies']
  /** Licenciado pelo plano (o núcleo está sempre licenciado). */
  licensed: boolean
  status: TenantModuleStatus
  enabledAt: Date | null
  lastError: string | null
  /** Módulos obrigatórios ainda por activar, pela ordem de activação. */
  missingDependencies: string[]
  /** Módulos activos que dependem deste (impedem a desactivação). */
  activeDependents: string[]
  features: FeatureView[]
}

interface Snapshot {
  modules: Map<string, RegistryModule>
  views: ModuleView[]
  licence: Licence
  active: Set<string>
}

async function snapshot(
  registry: RegistryStore,
  tenantModules: TenantModuleStore,
  licences: LicenceReader,
  scope: TenantScope,
  context: TenantContext,
  now: Date
): Promise<Snapshot> {
  const [list, rows, featureRows, licence] = await Promise.all([
    registry.list(),
    tenantModules.list(scope),
    tenantModules.listFeatures(scope),
    licences.forTenant(context.tenantId),
  ])
  const modules = new Map(list.map((m) => [m.code, m]))
  const rowById = new Map(rows.map((r) => [r.moduleId, r]))
  const featureById = new Map(featureRows.map((r) => [r.featureId, r]))

  const active = new Set<string>()
  for (const m of list) {
    if (m.kind === 'FOUNDATION' || rowById.get(m.id)?.status === 'ENABLED') active.add(m.code)
  }
  const licensed = (m: RegistryModule) =>
    m.kind === 'FOUNDATION' || (licence.entitled && licence.modules.includes(m.code))

  const views = list.map((m): ModuleView => {
    const row = rowById.get(m.id)
    const isLicensed = licensed(m)
    return {
      code: m.code,
      name: m.name,
      kind: m.kind,
      releaseVersion: m.releaseVersion,
      registryStatus: m.status,
      requires: m.dependencies,
      licensed: isLicensed,
      status: m.kind === 'FOUNDATION' ? 'ENABLED' : (row?.status ?? 'DISABLED'),
      enabledAt: row?.enabledAt ?? null,
      lastError: row?.lastError ?? null,
      missingDependencies: active.has(m.code) ? [] : missingDependencies(m.code, modules, active),
      activeDependents: activeDependents(m.code, modules, active),
      features: m.features.map((f): FeatureView => {
        const o = featureById.get(f.id)
        const expired = !!o?.expiresAt && o.expiresAt <= now
        const decision = decideFeature({
          moduleActive: active.has(m.code),
          moduleLicensed: isLicensed,
          featureLicensed:
            m.kind === 'FOUNDATION' ||
            (isLicensed && (f.defaultEnabled || licence.features.includes(f.code))),
          defaultEnabled: f.defaultEnabled,
          override: o?.override ?? null,
          overrideExpired: expired,
        })
        return {
          code: f.code,
          name: f.name,
          moduleCode: m.code,
          enabled: decision.enabled,
          reason: decision.enabled ? null : decision.reason,
          override: o?.override ?? null,
          overrideReason: o?.reason ?? null,
          overrideExpiresAt: o?.expiresAt ?? null,
        }
      }),
    }
  })
  return { modules, views, licence, active }
}

abstract class TenantRegistryCase {
  constructor(
    protected readonly uow: TenantUnitOfWork,
    protected readonly registry: RegistryStore,
    protected readonly tenantModules: TenantModuleStore,
    protected readonly licences: LicenceReader,
    protected readonly clock: Clock = systemClock
  ) {}

  protected snap(scope: TenantScope, context: TenantContext) {
    return snapshot(
      this.registry,
      this.tenantModules,
      this.licences,
      scope,
      context,
      this.clock.now()
    )
  }

  protected async views(scope: TenantScope, context: TenantContext) {
    const state = await this.snap(scope, context)
    return state.views
  }

  protected async featureViews(scope: TenantScope, context: TenantContext) {
    const views = await this.views(scope, context)
    return views.flatMap((m) => m.features)
  }

  protected async viewOf(scope: TenantScope, context: TenantContext, code: string) {
    const views = await this.views(scope, context)
    return views.find((v) => v.code === code)!
  }

  protected async registryModule(code: string) {
    const modules = await this.registry.list()
    return modules.find((m) => m.code === code)!
  }
}

/** Catálogo com dependências, licença, estado e diagnóstico do tenant. */
export class ListModules extends TenantRegistryCase {
  execute(context: TenantContext): Promise<ModuleView[]> {
    return this.uow.run((scope) => this.views(scope, context), context)
  }
}

/** Funcionalidades efectivas do tenant (licença AND módulo activo AND funcionalidade ligada). */
export class ListEffectiveFeatures extends TenantRegistryCase {
  execute(context: TenantContext): Promise<FeatureView[]> {
    return this.uow.run((scope) => this.featureViews(scope, context), context)
  }
}

export class IsFeatureEnabled extends TenantRegistryCase {
  /** Funcionalidade desconhecida → falso (nega por omissão). */
  async execute(context: TenantContext, featureCode: string): Promise<boolean> {
    const features = await this.uow.run((scope) => this.featureViews(scope, context), context)
    return features.find((f) => f.code === featureCode)?.enabled ?? false
  }
}

const conflict = (code: string, message: string, details: string[] = [], path = 'module') =>
  ApiError.conflict(
    code,
    message,
    details.map((d) => ({ path, code, message: d }))
  )

export class EnableModule extends TenantRegistryCase {
  constructor(
    uow: TenantUnitOfWork,
    registry: RegistryStore,
    tenantModules: TenantModuleStore,
    licences: LicenceReader,
    private readonly activator: ModuleActivator,
    clock: Clock = systemClock
  ) {
    super(uow, registry, tenantModules, licences, clock)
  }

  /**
   * Activa o módulo. Sem `withDependencies`, recusa se faltar algum módulo obrigatório (e diz quais);
   * com ele, activa-os antes, pela ordem certa. Repetir é seguro: cada passo é idempotente, e uma
   * falha deixa o módulo em ERROR para ser retomado sem duplicar sementes.
   */
  async execute(
    context: TenantContext,
    code: string,
    options: { withDependencies?: boolean } = {}
  ): Promise<ModuleView> {
    const targets = await this.uow.run(async (scope) => {
      await this.tenantModules.lock(scope)
      const state = await this.snap(scope, context)
      const module = state.modules.get(code)
      if (!module) throw ApiError.notFound('Módulo não encontrado.')
      if (module.kind === 'FOUNDATION') {
        throw conflict('MODULE_ALWAYS_ON', 'Os módulos do núcleo estão sempre activos.')
      }
      if (state.active.has(code)) return []
      if (module.status === 'DEPRECATED') {
        throw conflict('MODULE_DEPRECATED', 'Um módulo descontinuado não pode ser activado.')
      }
      const missing = missingDependencies(code, state.modules, state.active)
      const isLicensed = (c: string) => state.licence.entitled && state.licence.modules.includes(c)
      // Sem licença nada se activa; o pedido com dependências diz também as dependências por licenciar.
      const needed = options.withDependencies ? [...missing, code] : [code]
      const unlicensed = needed.filter((c) => !isLicensed(c))
      if (unlicensed.length > 0) {
        throw conflict(
          'MODULE_NOT_LICENSED',
          'O plano contratado não inclui todos os módulos necessários.',
          unlicensed,
          'licence'
        )
      }
      if (missing.length > 0 && !options.withDependencies) {
        throw conflict(
          'DEPENDENCIES_MISSING',
          'Active primeiro os módulos de que este depende.',
          missing,
          'dependencies'
        )
      }
      const order = [...missing, code]
      for (const c of order) {
        await this.tenantModules.upsert(scope, state.modules.get(c)!.id, {
          status: 'ENABLING',
          lastError: null,
        })
      }
      return order
    }, context)

    for (const target of targets) {
      try {
        await this.activator.activate(target, context)
      } catch {
        // O detalhe da falha fica nos logs do activador; ao tenant só se diz que foi a activação.
        await this.uow.run(async (scope) => {
          const module = await this.registryModule(target)
          await this.tenantModules.upsert(scope, module.id, {
            status: 'ERROR',
            lastError: 'A activação falhou; pode tentar novamente.',
          })
        }, context)
        throw conflict(
          'MODULE_ACTIVATION_FAILED',
          `A activação de ${target} falhou; tente novamente (o progresso mantém-se).`,
          [target],
          'activation'
        )
      }
      await this.uow.run(async (scope) => {
        const module = await this.registryModule(target)
        await this.tenantModules.upsert(scope, module.id, {
          status: 'ENABLED',
          enabledAt: this.clock.now(),
          lastError: null,
        })
      }, context)
    }
    return this.view(context, code)
  }

  private async view(context: TenantContext, code: string) {
    const views = await this.uow.run((scope) => this.views(scope, context), context)
    return views.find((v) => v.code === code)!
  }
}

export class DisableModule extends TenantRegistryCase {
  /**
   * Desactiva: bloqueia novos comandos do módulo, mas **não apaga** tabelas, dados nem histórico.
   * Recusa enquanto houver módulos activos que dependam dele.
   */
  async execute(
    context: TenantContext,
    code: string
  ): Promise<{ module: ModuleView; affectedFeatures: string[] }> {
    return this.uow.run(async (scope) => {
      await this.tenantModules.lock(scope)
      const state = await this.snap(scope, context)
      const module = state.modules.get(code)
      if (!module) throw ApiError.notFound('Módulo não encontrado.')
      if (module.kind === 'FOUNDATION') {
        throw conflict('MODULE_ALWAYS_ON', 'Os módulos do núcleo não se desactivam.')
      }
      const current = state.views.find((v) => v.code === code)!
      if (current.status === 'DISABLED') return { module: current, affectedFeatures: [] }
      const dependents = activeDependents(code, state.modules, state.active)
      if (dependents.length > 0) {
        throw conflict(
          'DEPENDENTS_ENABLED',
          'Desactive primeiro os módulos que dependem deste.',
          dependents,
          'dependents'
        )
      }
      const affectedFeatures = current.features.filter((f) => f.enabled).map((f) => f.code)
      await this.tenantModules.upsert(scope, module.id, { status: 'DISABLED', lastError: null })
      const after = await this.viewOf(scope, context, code)
      return { module: after, affectedFeatures }
    }, context)
  }
}

export class SetFeatureOverride extends TenantRegistryCase {
  /**
   * Liga/desliga uma funcionalidade para o tenant (`override: null` repõe o valor por omissão). Um override
   * a favor **nunca** ultrapassa a licença do plano.
   */
  async execute(
    context: TenantContext,
    featureCode: string,
    input: { override: boolean | null; reason: string | null; expiresAt: Date | null }
  ): Promise<FeatureView> {
    const now = this.clock.now()
    if (input.override !== null && !input.reason?.trim()) {
      throw new ApiError(422, 'VALIDATION_ERROR', 'Verifique os campos indicados.', [
        { path: 'reason', code: 'REQUIRED', message: 'Indique o motivo do override.' },
      ])
    }
    if (input.expiresAt && input.expiresAt <= now) {
      throw new ApiError(422, 'VALIDATION_ERROR', 'Verifique os campos indicados.', [
        { path: 'expiresAt', code: 'IN_THE_PAST', message: 'O prazo tem de ser futuro.' },
      ])
    }
    return this.uow.run(async (scope) => {
      await this.tenantModules.lock(scope)
      const state = await this.snap(scope, context)
      const feature = state.views.flatMap((m) => m.features).find((f) => f.code === featureCode)
      if (!feature) throw ApiError.notFound('Funcionalidade não encontrada.')
      const module = state.modules.get(feature.moduleCode)!
      const registryFeature = module.features.find((f) => f.code === featureCode)!
      const moduleView = state.views.find((v) => v.code === module.code)!
      const featureLicensed =
        module.kind === 'FOUNDATION' ||
        (moduleView.licensed &&
          (registryFeature.defaultEnabled || state.licence.features.includes(featureCode)))
      if (input.override === true && !featureLicensed) {
        throw conflict(
          'FEATURE_NOT_LICENSED',
          'O plano contratado não inclui esta funcionalidade; um override não ultrapassa a licença.',
          [featureCode],
          'licence'
        )
      }
      await this.tenantModules.upsertFeature(scope, registryFeature.id, {
        override: input.override,
        reason: input.override === null ? null : input.reason!.trim().slice(0, 500),
        expiresAt: input.override === null ? null : input.expiresAt,
      })
      const features = await this.featureViews(scope, context)
      return features.find((f) => f.code === featureCode)!
    }, context)
  }
}
