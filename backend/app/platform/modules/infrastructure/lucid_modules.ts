import db from '@adonisjs/lucid/services/db'
import { LucidTenantScope, type TenantContext, type TenantScope } from '#core/tenancy/index'
import { billingServices } from '#platform/billing/index'
import type {
  ManifestDependency,
  ModuleKind,
  ModuleManifest,
  RegistryModule,
  TenantModuleStatus,
} from '#platform/modules/domain/module'
import type {
  Licence,
  LicenceReader,
  ModuleActivator,
  RegistryStore,
  TenantFeatureRow,
  TenantModuleRow,
  TenantModuleStore,
} from '#platform/modules/application/ports'

const conn = () => db.connection('runtime')

export class LucidRegistryStore implements RegistryStore {
  async sync(manifests: readonly ModuleManifest[]) {
    return conn().transaction(async (trx) => {
      await trx.rawQuery('select pg_advisory_xact_lock(hashtext(?))', ['modules:registry'])
      let created = 0
      let updated = 0
      const ids = new Map<string, string>()

      for (const m of manifests) {
        const result = await trx.rawQuery(
          `insert into modules (code, name, release_version, status, manifest, min_core_version)
           values (?, ?, ?, 'AVAILABLE', ?::jsonb, ?)
           on conflict (code) do update
             set name = excluded.name, release_version = excluded.release_version, status = 'AVAILABLE',
                 manifest = excluded.manifest, min_core_version = excluded.min_core_version,
                 updated_at = now(), version = modules.version + 1
           returning id, (xmax = 0) as inserted`,
          [m.code, m.name, m.releaseVersion, JSON.stringify(m), m.minCoreVersion]
        )
        const row = (result.rows as { id: string; inserted: boolean }[])[0]
        ids.set(m.code, row.id)
        if (row.inserted) created++
        else updated++
      }

      for (const m of manifests) {
        const moduleId = ids.get(m.code)!
        // As arestas do grafo são derivadas do manifesto: regeneram-se.
        await trx.from('module_dependencies').where('module_id', moduleId).delete()
        for (const d of m.dependencies) {
          await trx.table('module_dependencies').insert({
            module_id: moduleId,
            required_module_id: ids.get(d.code),
            version_constraint: d.constraint,
            optional: d.optional,
          })
        }
        for (const f of m.features) {
          await trx.rawQuery(
            `insert into features (module_id, code, name, default_enabled, retired)
             values (?, ?, ?, ?, false)
             on conflict (code) do update
               set name = excluded.name, default_enabled = excluded.default_enabled, retired = false,
                   updated_at = now(), version = features.version + 1
             where features.module_id = excluded.module_id`,
            [moduleId, f.code, f.name, f.defaultEnabled]
          )
        }
        await trx
          .from('features')
          .where('module_id', moduleId)
          .whereNotIn(
            'code',
            m.features.map((f) => f.code)
          )
          .update({ retired: true })
      }

      const gone = await trx
        .from('modules')
        .whereNotIn(
          'code',
          manifests.map((m) => m.code)
        )
        .whereNot('status', 'DEPRECATED')
        .update({ status: 'DEPRECATED', updated_at: new Date() })
      return { created, updated, deprecated: Number(gone) }
    })
  }

  async list(): Promise<RegistryModule[]> {
    const modules = await conn().from('modules').orderBy('code')
    const deps = await conn().from('module_dependencies')
    const features = await conn().from('features').where('retired', false).orderBy('code')
    const codeById = new Map<string, string>(modules.map((m: any) => [m.id, m.code]))
    return modules.map((m: any) => ({
      id: m.id,
      code: m.code,
      name: m.name,
      kind: (m.manifest.kind ?? 'MODULE') as ModuleKind,
      releaseVersion: m.release_version,
      status: m.status,
      dependencies: deps
        .filter((d: any) => d.module_id === m.id)
        .map((d: any) => ({
          code: codeById.get(d.required_module_id)!,
          constraint: d.version_constraint,
          optional: d.optional,
        }))
        .sort((a: ManifestDependency, b: ManifestDependency) => a.code.localeCompare(b.code)),
      features: features
        .filter((f: any) => f.module_id === m.id)
        .map((f: any) => ({
          id: f.id,
          code: f.code,
          name: f.name,
          defaultEnabled: f.default_enabled,
        })),
    }))
  }
}

const trxOf = (scope: TenantScope) => (scope as LucidTenantScope).trx
const tenantOf = (scope: TenantScope) => (scope as LucidTenantScope).context.tenantId

export class LucidTenantModuleStore implements TenantModuleStore {
  async lock(scope: TenantScope) {
    await trxOf(scope).rawQuery('select pg_advisory_xact_lock(hashtext(?))', [
      `tenant-modules:${tenantOf(scope)}`,
    ])
  }

  async list(scope: TenantScope): Promise<TenantModuleRow[]> {
    const rows = await trxOf(scope).from('tenant_modules').where('tenant_id', tenantOf(scope))
    return rows.map((r: any) => ({
      moduleId: r.module_id,
      status: r.status as TenantModuleStatus,
      enabledAt: r.enabled_at,
      lastError: r.last_error,
      configuration: r.configuration,
    }))
  }

  async upsert(
    scope: TenantScope,
    moduleId: string,
    patch: { status: TenantModuleStatus; enabledAt?: Date | null; lastError?: string | null }
  ) {
    const context = (scope as LucidTenantScope).context
    await trxOf(scope).rawQuery(
      `insert into tenant_modules
         (tenant_id, module_id, status, enabled_at, last_error, created_by_membership_id, updated_by_membership_id)
       values (?, ?, ?, ?, ?, ?, ?)
       on conflict (tenant_id, module_id) do update
         set status = excluded.status,
             enabled_at = case when excluded.status = 'ENABLED' then excluded.enabled_at
                               else tenant_modules.enabled_at end,
             last_error = excluded.last_error, updated_at = now(),
             updated_by_membership_id = excluded.updated_by_membership_id,
             version = tenant_modules.version + 1`,
      [
        context.tenantId,
        moduleId,
        patch.status,
        (patch.enabledAt ?? null) as never,
        (patch.lastError ?? null) as never,
        context.membershipId as never,
        context.membershipId as never,
      ]
    )
  }

  async listFeatures(scope: TenantScope): Promise<TenantFeatureRow[]> {
    const rows = await trxOf(scope).from('tenant_features').where('tenant_id', tenantOf(scope))
    return rows.map((r: any) => ({
      featureId: r.feature_id,
      override: r.override,
      reason: r.reason,
      expiresAt: r.expires_at,
    }))
  }

  async upsertFeature(
    scope: TenantScope,
    featureId: string,
    value: { override: boolean | null; reason: string | null; expiresAt: Date | null }
  ) {
    const context = (scope as LucidTenantScope).context
    await trxOf(scope).rawQuery(
      `insert into tenant_features
         (tenant_id, feature_id, override, reason, expires_at, created_by_membership_id, updated_by_membership_id)
       values (?, ?, ?, ?, ?, ?, ?)
       on conflict (tenant_id, feature_id) do update
         set override = excluded.override, reason = excluded.reason, expires_at = excluded.expires_at,
             updated_at = now(), updated_by_membership_id = excluded.updated_by_membership_id,
             version = tenant_features.version + 1`,
      [
        context.tenantId,
        featureId,
        value.override as never,
        value.reason as never,
        value.expiresAt as never,
        context.membershipId as never,
        context.membershipId as never,
      ]
    )
  }
}

/** Direitos do plano contratado (C02), por tenant. */
export class BillingLicenceReader implements LicenceReader {
  async forTenant(tenantId: string): Promise<Licence> {
    return billingServices().resolveEntitlements.execute(tenantId)
  }
}

/** Corre o activador registado para o módulo (nenhum = nada a semear). */
export class CodeModuleActivator implements ModuleActivator {
  constructor(
    private readonly activators: Readonly<Record<string, (context: TenantContext) => Promise<void>>>
  ) {}

  async activate(moduleCode: string, context: TenantContext) {
    await this.activators[moduleCode]?.(context)
  }
}
