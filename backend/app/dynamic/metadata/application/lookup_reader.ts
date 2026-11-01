import type { TenantContext, TenantScope, TenantUnitOfWork } from '#core/tenancy/index'
import type { RecordValues } from '#dynamic/metadata/domain/record'
import { lookupOf } from '#dynamic/metadata/domain/lookup'
import { resourceOf } from '#dynamic/metadata/application/access_resource'
import type {
  AccessControl,
  DynamicRecord,
  EntityDefinition,
  EntityStore,
  RecordStore,
  SchemaVersion,
  VersionStore,
} from '#dynamic/metadata/application/ports'

interface Need {
  recordId: string
  lookupCode: string
  sourceField: string
  entityId: string
  targetId: string
}

interface Target {
  entity: EntityDefinition
  row: DynamicRecord
  version: SchemaVersion
}

/**
 * Lê, em tempo real, os valores relacionados (`LOOKUP`) de uma página de registos. Cada valor só aparece se a
 * pessoa puder ler o registo de origem (permissão, regra de propriedade e políticas ABAC da entidade de
 * destino) e o campo de origem não estiver escondido nem for sensível sem `dynamic.sensitive`. Em qualquer
 * outro caso o valor é vazio: nunca se revela a existência nem o conteúdo do que não se pode ver.
 */
export class LookupReader {
  constructor(
    private readonly uow: TenantUnitOfWork,
    private readonly entities: EntityStore,
    private readonly versions: VersionStore,
    private readonly records: RecordStore,
    private readonly access: AccessControl
  ) {}

  /**
   * Valores por id de registo e código do campo relacionado (`null` = vazio). Os valores relacionados seguem a
   * versão **em vigor** da entidade (não a do registo): como não se guardam, valem para todos os registos.
   */
  async read(
    context: TenantContext,
    rows: readonly DynamicRecord[],
    version: SchemaVersion
  ): Promise<Map<string, Record<string, unknown>>> {
    const needs: Need[] = []
    const result = new Map<string, Record<string, unknown>>()
    for (const row of rows) {
      const stored = { ...row.data, ...row.sensitiveData }
      for (const field of version.fields) {
        const lookup = lookupOf(field)
        if (!lookup || field.archived) continue
        const values = result.get(row.id) ?? {}
        values[field.code] = null
        result.set(row.id, values)
        const relation = version.fields.find((f) => f.code === lookup.relationField)
        const targetId = stored[lookup.relationField]
        if (!relation?.referenceEntityId || typeof targetId !== 'string') continue
        needs.push({
          recordId: row.id,
          lookupCode: field.code,
          sourceField: lookup.sourceField,
          entityId: relation.referenceEntityId,
          targetId,
        })
      }
    }
    if (needs.length === 0) return result

    const targets = await this.uow.run((scope) => this.load(scope, needs), context)
    const permitted = new Map<string, Promise<{ hidden: Set<string>; sensitive: boolean } | null>>()
    for (const need of needs) {
      const key = `${need.entityId}:${need.targetId}`
      const target = targets.get(key)
      if (!target) continue
      if (!permitted.has(key)) permitted.set(key, this.permit(context, target))
      const grant = await permitted.get(key)
      if (!grant) continue
      const source = target.version.fields.find((f) => f.code === need.sourceField)
      if (!source || source.archived || grant.hidden.has(source.code)) continue
      if (source.sensitive && !grant.sensitive) continue
      const stored: RecordValues = source.sensitive ? target.row.sensitiveData : target.row.data
      const value = stored[source.code]
      ;(result.get(need.recordId) as Record<string, unknown>)[need.lookupCode] = value ?? null
    }
    return result
  }

  /** Os registos de origem (e as suas entidades e versões), sem repetir leituras. */
  private async load(scope: TenantScope, needs: readonly Need[]): Promise<Map<string, Target>> {
    const entities = new Map<string, EntityDefinition | null>()
    const versions = new Map<string, SchemaVersion | null>()
    const targets = new Map<string, Target>()
    for (const need of needs) {
      const key = `${need.entityId}:${need.targetId}`
      if (targets.has(key)) continue
      if (!entities.has(need.entityId)) {
        entities.set(need.entityId, await this.entities.find(scope, need.entityId))
      }
      const entity = entities.get(need.entityId)
      if (!entity) continue
      const row = await this.records.find(scope, entity.id, need.targetId)
      if (!row) continue
      if (!versions.has(row.schemaVersionId)) {
        versions.set(row.schemaVersionId, await this.versions.findById(scope, row.schemaVersionId))
      }
      const version = versions.get(row.schemaVersionId)
      if (version) targets.set(key, { entity, row, version })
    }
    return targets
  }

  /** O que a pessoa pode ver do registo de origem; `null` se nem o pode ler. */
  private async permit(context: TenantContext, target: Target) {
    const { entity, row } = target
    if (entity.ownershipMode === 'OWNER' && row.ownerMembershipId !== context.membershipId) {
      const all = await this.access.decide(context, 'dynamic.all', resourceOf(entity, {}))
      if (!all.allowed) return null
    }
    const decision = await this.access.decide(
      context,
      'dynamic.read',
      resourceOf(entity, {
        unitId: row.organizationUnitId,
        ownerMembershipId: row.ownerMembershipId,
      })
    )
    if (!decision.allowed) return null
    const sensitive = await this.access.decide(context, 'dynamic.sensitive', resourceOf(entity, {}))
    return { hidden: new Set(decision.hiddenFields), sensitive: sensitive.allowed }
  }
}
