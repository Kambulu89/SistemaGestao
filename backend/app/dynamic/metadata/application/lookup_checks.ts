import type { TenantScope } from '#core/tenancy/index'
import type { FieldSpec, Issue } from '#dynamic/metadata/domain/field_types'
import { LOOKUP_SOURCE_TYPES, lookupOf } from '#dynamic/metadata/domain/lookup'
import type {
  EntityDefinition,
  EntityStore,
  VersionStore,
} from '#dynamic/metadata/application/ports'

/**
 * Verifica os valores relacionados de um conjunto de campos contra a entidade de destino: o campo de origem
 * existe na versão publicada (ou, numa auto-referência, no próprio conjunto), é de um tipo que se pode
 * mostrar e, se for sensível, o valor relacionado também o é. Preenche `sourceType` e `scale`, que o
 * servidor deriva do campo de origem (a interface precisa deles para formatar o valor).
 */
export async function checkLookupTargets(
  scope: TenantScope,
  stores: { entities: EntityStore; versions: VersionStore },
  self: EntityDefinition,
  fields: readonly FieldSpec[]
): Promise<{ code: string; issue: Issue }[]> {
  const problems: { code: string; issue: Issue }[] = []
  const byCode = new Map(fields.map((f) => [f.code, f]))
  for (const field of fields) {
    const lookup = lookupOf(field)
    if (!lookup || field.archived) continue
    const relation = byCode.get(lookup.relationField)
    // As relações em falta ou de tipo errado já foram comunicadas pelo domínio.
    if (!relation || relation.archived || relation.type !== 'ENTITY_REFERENCE') continue
    const report = (code: string, message: string) =>
      problems.push({
        code: field.code,
        issue: { path: 'validation.sourceField', code, message },
      })

    let sourceFields: readonly FieldSpec[]
    if (relation.referenceEntityId === self.id) {
      sourceFields = fields
    } else {
      const target = relation.referenceEntityId
        ? await stores.entities.find(scope, relation.referenceEntityId)
        : null
      const published =
        target && target.publishedVersion !== null
          ? await stores.versions.findByRevision(scope, target.id, target.publishedVersion)
          : null
      if (!published) {
        report('LOOKUP_TARGET_NOT_PUBLISHED', 'A entidade de destino tem de estar publicada.')
        continue
      }
      sourceFields = published.fields
    }
    const source = sourceFields.find((f) => f.code === lookup.sourceField)
    if (!source || source.archived) {
      report('LOOKUP_UNKNOWN_SOURCE', `O campo "${lookup.sourceField}" não existe no destino.`)
    } else if (source.code === field.code) {
      report('LOOKUP_SELF', 'Um valor relacionado não pode ler-se a si próprio.')
    } else if (!(LOOKUP_SOURCE_TYPES as readonly string[]).includes(source.type)) {
      report(
        'LOOKUP_SOURCE_TYPE',
        `Não se pode mostrar um campo ${source.type} como valor relacionado.`
      )
    } else if (source.sensitive && !field.sensitive) {
      report(
        'LOOKUP_LEAKS_SENSITIVE',
        `O campo "${source.code}" é sensível: marque também o valor relacionado como sensível.`
      )
    } else {
      field.validation = {
        ...field.validation,
        sourceType: source.type,
        ...(typeof source.validation.scale === 'number' ? { scale: source.validation.scale } : {}),
      }
    }
  }
  return problems
}
