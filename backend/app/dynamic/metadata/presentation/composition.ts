import { iamServices } from '#core/permissions/index'
import { LucidTenantDatabase } from '#core/tenancy/index'
import { EntityDefinitionUseCases } from '#dynamic/metadata/application/entity_use_cases'
import type { AccessControl } from '#dynamic/metadata/application/ports'
import { RecordUseCases } from '#dynamic/metadata/application/record_use_cases'
import {
  LucidEntityStore,
  LucidRecordStore,
  LucidReferenceLookup,
  LucidVersionStore,
} from '#dynamic/metadata/infrastructure/lucid_metadata'

function build() {
  const uow = new LucidTenantDatabase()
  const entities = new LucidEntityStore()
  const versions = new LucidVersionStore()
  const records = new LucidRecordStore()
  const access: AccessControl = {
    async decide(context, permission, resource) {
      const decision = await iamServices().authorize.decision(context, permission, resource)
      return {
        allowed: decision.allowed,
        hiddenFields: decision.hiddenFields,
        readOnlyFields: decision.readOnlyFields,
      }
    },
  }
  return {
    entities: new EntityDefinitionUseCases(uow, entities, versions, records),
    records: new RecordUseCases(
      uow,
      entities,
      versions,
      records,
      new LucidReferenceLookup(),
      access
    ),
  }
}

let instance: ReturnType<typeof build> | undefined

export const metadataServices = () => (instance ??= build())
