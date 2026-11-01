import { test } from '@japa/runner'
import { normalizeField, normalizeFields } from '#dynamic/metadata/domain/field_spec'
import type { FieldSpec, Issue } from '#dynamic/metadata/domain/field_types'
import { checkLookupSet, lookupOf, missingLookupRelations } from '#dynamic/metadata/domain/lookup'
import { validateRecordData } from '#dynamic/metadata/domain/record'

const lookup = (validation: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  code: 'valor',
  label: 'Valor',
  type: 'LOOKUP',
  validation,
  ...extra,
})
const reference = {
  code: 'cliente',
  label: 'Cliente',
  type: 'ENTITY_REFERENCE',
  referenceEntityId: '11111111-1111-4111-8111-111111111111',
}

function spec(input: Record<string, unknown>): FieldSpec {
  const issues: Issue[] = []
  const field = normalizeField(input, 0, issues)
  if (!field) throw new Error(JSON.stringify(issues))
  return field
}

test.group('metadados | valores relacionados (domínio)', () => {
  test('é só de leitura, não obrigatório, sem valor por omissão e com onMissing=empty por omissão', ({
    assert,
  }) => {
    const field = spec(lookup({ relationField: 'cliente', sourceField: 'nome' }))
    assert.isTrue(field.readOnly)
    assert.equal(lookupOf(field)?.onMissing, 'empty')

    const issues: Issue[] = []
    normalizeField(
      lookup(
        { relationField: 'cliente', sourceField: 'nome' },
        { required: true, defaultValue: 'x' }
      ),
      0,
      issues
    )
    assert.sameMembers(
      issues.map((i) => i.code),
      ['LOOKUP_REQUIRED', 'DEFAULT_NOT_ALLOWED']
    )
  })

  test('sourceType e scale enviados pelo cliente são descartados (derivam do campo de origem)', ({
    assert,
  }) => {
    const field = spec(
      lookup({ relationField: 'cliente', sourceField: 'nome', sourceType: 'TEXT', scale: 9 })
    )
    assert.notProperty(field.validation, 'sourceType')
    assert.notProperty(field.validation, 'scale')
  })

  test('regras de validação alheias ao tipo são recusadas', ({ assert }) => {
    const issues: Issue[] = []
    normalizeField(
      lookup({ relationField: 'cliente', sourceField: 'nome', unique: true, min: 1 }),
      0,
      issues
    )
    assert.sameMembers(
      issues.map((i) => i.code),
      ['UNKNOWN_VALIDATION', 'UNKNOWN_VALIDATION']
    )
  })

  test('a relação tem de existir, estar activa e ser uma referência a entidade', ({ assert }) => {
    const codes = (fields: Record<string, unknown>[]) => {
      const issues: Issue[] = []
      normalizeFields(fields, issues)
      return issues.map((i) => i.code)
    }
    const ok = [reference, lookup({ relationField: 'cliente', sourceField: 'nome' })]
    assert.deepEqual(codes(ok), [])
    assert.deepEqual(codes([lookup({ relationField: 'cliente', sourceField: 'nome' })]), [
      'LOOKUP_UNKNOWN_RELATION',
    ])
    assert.deepEqual(
      codes([
        { code: 'cliente', label: 'Cliente', type: 'TEXT' },
        lookup({ relationField: 'cliente', sourceField: 'nome' }),
      ]),
      ['LOOKUP_RELATION_NOT_REFERENCE']
    )
    const archived = [
      { ...spec(reference), archived: true },
      spec(lookup({ relationField: 'cliente', sourceField: 'nome' })),
    ]
    assert.equal(checkLookupSet(archived)[0].issue.code, 'LOOKUP_ARCHIVED_RELATION')
  })

  test('o cliente não escreve o valor; onMissing=error exige a relação', ({ assert }) => {
    const fields = [
      spec(reference),
      spec(lookup({ relationField: 'cliente', sourceField: 'nome', onMissing: 'error' })),
    ]
    const written = validateRecordData(fields, { valor: 'x' }, null)
    assert.equal(written.issues[0].code, 'READ_ONLY')

    const missing = validateRecordData(fields, {}, null)
    assert.deepEqual(
      missing.issues.map((i) => `${i.path}:${i.code}`),
      ['data.cliente:LOOKUP_RELATION_REQUIRED']
    )
    assert.deepEqual(missingLookupRelations(fields, { cliente: 'abc' }), [])
  })
})
