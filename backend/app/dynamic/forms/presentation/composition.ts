import { LucidTenantDatabase } from '#core/tenancy/index'
import { metadataServices } from '#dynamic/metadata/index'
import { FormUseCases } from '#dynamic/forms/application/form_use_cases'
import type { FormTarget, FormTargets } from '#dynamic/forms/application/ports'
import { LucidFormStore } from '#dynamic/forms/infrastructure/lucid_forms'

/** As entidades vêm do módulo de metadados, pela sua API pública. */
const targets: FormTargets = {
  async findByCode(context, code) {
    const entities = await metadataServices().entities.list(context)
    const entity = entities.find((e) => e.code === code)
    return entity ? this.findById(context, entity.id) : null
  },
  async findById(context, id) {
    const detail = await metadataServices().entities.get(context, id)
    const target: FormTarget = {
      id: detail.entity.id,
      code: detail.entity.code,
      published: detail.published !== null && detail.entity.status === 'PUBLISHED',
      revision: detail.published?.revision ?? null,
      fields: (detail.published?.fields ?? []).map((f) => ({
        code: f.code,
        required: f.required,
        readOnly: f.readOnly,
        sensitive: f.sensitive,
        archived: f.archived,
        defaultValue: f.defaultValue,
      })),
    }
    return target
  },
}

function build() {
  return { forms: new FormUseCases(new LucidTenantDatabase(), new LucidFormStore(), targets) }
}

let instance: ReturnType<typeof build> | undefined

export const formServices = () => (instance ??= build())
