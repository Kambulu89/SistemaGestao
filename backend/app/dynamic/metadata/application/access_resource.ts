import type { EntityDefinition } from '#dynamic/metadata/application/ports'

/** Atributos do recurso que alimentam as políticas ABAC (o código da entidade é `resource.entity`). */
export function resourceOf(
  entity: EntityDefinition,
  extra: { unitId?: string | null; ownerMembershipId?: string | null }
) {
  return {
    entity: entity.code,
    ownershipMode: entity.ownershipMode,
    ...(extra.unitId ? { unitId: extra.unitId } : {}),
    ...(extra.ownerMembershipId ? { ownerMembershipId: extra.ownerMembershipId } : {}),
  }
}
