import { test } from '@japa/runner'
import { checkCompatibility } from '#dynamic/metadata/domain/compatibility'
import { normalizeField, normalizeFields } from '#dynamic/metadata/domain/field_spec'
import type { FieldSpec, Issue } from '#dynamic/metadata/domain/field_types'
import {
  collectReferences,
  partition,
  searchText,
  uniqueKeys,
  validateRecordData,
} from '#dynamic/metadata/domain/record'
import {
  checkPattern,
  parseDate,
  parseDecimal,
  parseInstant,
} from '#dynamic/metadata/domain/scalars'
import { validateValue } from '#dynamic/metadata/domain/value'

const field = (input: Record<string, unknown>): FieldSpec => {
  const issues: Issue[] = []
  const spec = normalizeField({ label: 'Campo', ...input }, 0, issues)
  if (!spec) throw new Error(`campo inválido: ${JSON.stringify(issues)}`)
  return spec
}
const issuesOf = (input: Record<string, unknown>): Issue[] => {
  const issues: Issue[] = []
  normalizeField({ label: 'Campo', ...input }, 0, issues)
  return issues
}
const DEC = { precision: 10, scale: 2 }

test.group('metadados | decimais, datas e padrões', () => {
  test('decimal exacto: canónico com a escala, sem float, com recusas claras', ({ assert }) => {
    assert.deepInclude(parseDecimal('12.5', DEC), { ok: true, canonical: '12.50' })
    assert.deepInclude(parseDecimal('-0.00', DEC), { ok: true, canonical: '0.00' })
    assert.deepInclude(parseDecimal('007', DEC), { ok: true, canonical: '7.00' })
    assert.deepInclude(parseDecimal('1.234', DEC), { ok: false, code: 'TOO_MANY_DECIMALS' })
    assert.deepInclude(parseDecimal('123456789', DEC), { ok: false, code: 'TOO_MANY_DIGITS' })
    for (const bad of ['NaN', 'Infinity', '1e3', '1,5', '', '--1', '.5'])
      assert.isFalse(parseDecimal(bad, DEC).ok, bad)
    // 0.1 + 0.2 nunca passa por binário: a comparação é por inteiros escalados.
    const a = parseDecimal('0.10', DEC)
    const b = parseDecimal('0.20', DEC)
    const c = parseDecimal('0.30', DEC)
    assert.isTrue(a.ok && b.ok && c.ok && a.scaled + b.scaled === c.scaled)
  })

  test('datas civis e instantes ISO com fuso (normalizados para UTC)', ({ assert }) => {
    assert.equal(parseDate('2026-02-28'), '2026-02-28')
    assert.isNull(parseDate('2026-02-30'))
    assert.isNull(parseDate('26-02-01'))
    assert.equal(parseInstant('2026-03-01T10:00:00+01:00'), '2026-03-01T09:00:00.000Z')
    assert.isNull(parseInstant('2026-03-01T10:00:00'))
    assert.isNull(parseInstant('2026-03-01T25:00:00Z'))
  })

  test('padrões perigosos (retrocesso exponencial, retrovisores) são recusados', ({ assert }) => {
    assert.isNull(checkPattern('^[A-Z]{2}-\\d{4}$'))
    for (const bad of ['(a+)+$', '(a|aa)*b', '(.*)*', '(?=x)y', '(a)\\1', '[', 'x'.repeat(201)])
      assert.isNotNull(checkPattern(bad), bad)
  })
})

test.group('metadados | definição de campos', () => {
  test('tipos ainda não disponíveis são recusados com um erro explícito', ({ assert }) => {
    for (const type of ['FILE', 'IMAGE', 'CURRENCY', 'CHECKBOX', 'AUTONUMBER']) {
      const [first] = issuesOf({ code: 'campo', type })
      assert.equal(first.code, 'FIELD_TYPE_NOT_SUPPORTED', type)
    }
    assert.equal(issuesOf({ code: 'campo', type: 'ALIEN' })[0].code, 'INVALID_TYPE')
  })

  test('regras de validação desconhecidas, incoerentes ou fora do tipo são recusadas', ({
    assert,
  }) => {
    const codes = (input: Record<string, unknown>) => issuesOf(input).map((i) => i.code)
    assert.include(
      codes({ code: 'a1', type: 'BOOLEAN', validation: { min: 1 } }),
      'UNKNOWN_VALIDATION'
    )
    assert.include(
      codes({ code: 'a1', type: 'TEXT', validation: { minLength: 9, maxLength: 3 } }),
      'INVALID_VALIDATION'
    )
    assert.include(
      codes({ code: 'a1', type: 'TEXT', validation: { maxLength: 999 } }),
      'INVALID_VALIDATION'
    )
    assert.include(codes({ code: 'a1', type: 'DECIMAL', validation: {} }), 'INVALID_VALIDATION')
    assert.include(
      codes({ code: 'a1', type: 'DECIMAL', validation: { precision: 5, scale: 6 } }),
      'INVALID_VALIDATION'
    )
    assert.include(codes({ code: 'a1', type: 'SELECT' }), 'INVALID_OPTIONS')
    assert.include(
      codes({ code: 'a1', type: 'TEXT', options: [{ code: 'x', label: 'X' }] }),
      'OPTIONS_NOT_ALLOWED'
    )
    assert.include(codes({ code: 'a1', type: 'ENTITY_REFERENCE' }), 'REFERENCE_REQUIRED')
    assert.include(codes({ code: 'Mau', type: 'TEXT' }), 'INVALID_CODE')
  })

  test('único: só tipos que o admitem, nunca sensível nem com valor por omissão', ({ assert }) => {
    const codes = (input: Record<string, unknown>) => issuesOf(input).map((i) => i.code)
    assert.include(
      codes({ code: 'a1', type: 'BOOLEAN', validation: { unique: true } }),
      'UNKNOWN_VALIDATION'
    )
    assert.include(
      codes({ code: 'a1', type: 'TEXT', sensitive: true, validation: { unique: true } }),
      'UNIQUE_SENSITIVE'
    )
    assert.include(
      codes({ code: 'a1', type: 'TEXT', defaultValue: 'x', validation: { unique: true } }),
      'UNIQUE_DEFAULT'
    )
    assert.isEmpty(codes({ code: 'a1', type: 'TEXT', validation: { unique: true } }))
  })

  test('o valor por omissão passa pelas regras do campo; só leitura obrigatório precisa de um', ({
    assert,
  }) => {
    const codes = (input: Record<string, unknown>) => issuesOf(input).map((i) => i.code)
    assert.include(
      codes({ code: 'a1', type: 'NUMBER', validation: { max: 5 }, defaultValue: 9 }),
      'TOO_LARGE'
    )
    assert.include(
      codes({
        code: 'a1',
        type: 'SELECT',
        options: [{ code: 'a', label: 'A' }],
        defaultValue: 'b',
      }),
      'INVALID_OPTION'
    )
    assert.include(
      codes({ code: 'a1', type: 'TEXT', readOnly: true, required: true }),
      'READ_ONLY_REQUIRED'
    )
    assert.isEmpty(
      codes({ code: 'a1', type: 'TEXT', readOnly: true, required: true, defaultValue: 'x' })
    )
  })

  test('conjunto de campos: códigos repetidos são recusados', ({ assert }) => {
    const issues: Issue[] = []
    normalizeFields(
      [
        { code: 'nome', label: 'A', type: 'TEXT' },
        { code: 'nome', label: 'B', type: 'TEXT' },
      ],
      issues
    )
    assert.equal(issues[0].code, 'DUPLICATE_FIELD')
  })
})

test.group('metadados | valores e registos', () => {
  const text = field({
    code: 'matricula',
    type: 'TEXT',
    validation: { pattern: '^[A-Z]{2}-\\d{2}$', maxLength: 5 },
  })
  const money = field({
    code: 'valor',
    type: 'DECIMAL',
    validation: { precision: 12, scale: 2, min: '0.00' },
  })
  const colour = field({
    code: 'cor',
    type: 'SELECT',
    options: [
      { code: 'red', label: 'Vermelho' },
      { code: 'blue', label: 'Azul' },
    ],
  })

  test('cada tipo valida e normaliza', ({ assert }) => {
    assert.deepEqual(validateValue(text, 'LD-12', null), { ok: true, value: 'LD-12' })
    assert.equal((validateValue(text, 'ld-12', null) as any).code, 'PATTERN_MISMATCH')
    assert.deepEqual(validateValue(money, '10.5', null), { ok: true, value: '10.50' })
    assert.equal((validateValue(money, 10.5, null) as any).code, 'INVALID_TYPE')
    assert.equal((validateValue(money, '-1.00', null) as any).code, 'TOO_SMALL')
    assert.deepEqual(
      validateValue(field({ code: 'mail', type: 'EMAIL' }), ' Ana@Exemplo.PT ', null),
      {
        ok: true,
        value: 'ana@exemplo.pt',
      }
    )
    assert.isFalse(
      validateValue(field({ code: 'site', type: 'URL' }), 'javascript:alert(1)', null).ok
    )
    assert.isTrue(
      validateValue(field({ code: 'site', type: 'URL' }), 'https://exemplo.pt', null).ok
    )
    assert.equal(
      (validateValue(field({ code: 'num', type: 'NUMBER' }), 1.5, null) as any).code,
      'INVALID_TYPE'
    )
    const multi = field({
      code: 'tags',
      type: 'MULTISELECT',
      options: [
        { code: 'a', label: 'A' },
        { code: 'b', label: 'B' },
      ],
      validation: { maxSelected: 1 },
    })
    assert.equal((validateValue(multi, ['a', 'b'], null) as any).code, 'TOO_MANY')
    assert.equal((validateValue(multi, ['a', 'a'], null) as any).code, 'DUPLICATE_OPTION')
  })

  test('uma opção arquivada continua aceite se for o valor actual do registo', ({ assert }) => {
    const archived: FieldSpec = {
      ...colour,
      options: [...colour.options, { code: 'old', label: 'Antiga', archived: true }],
    }
    assert.isFalse(validateValue(archived, 'old', null).ok)
    assert.isTrue(validateValue(archived, 'old', 'old').ok)
  })

  test('criação: omissões, obrigatórios, desconhecidos e só de leitura; caminho completo do campo', ({
    assert,
  }) => {
    const fields = [
      field({ code: 'nome', type: 'TEXT', required: true }),
      field({ code: 'pais', type: 'TEXT', defaultValue: 'AO' }),
      field({ code: 'ref', type: 'TEXT', readOnly: true, defaultValue: 'X' }),
    ]
    const ok = validateRecordData(fields, { nome: 'Ana' }, null)
    assert.deepEqual(ok.values, { nome: 'Ana', pais: 'AO', ref: 'X' })
    const bad = validateRecordData(fields, { pais: 'PT', ref: 'Y', alien: 1, __proto__x: 2 }, null)
    assert.deepEqual(
      bad.issues.map((i) => `${i.path}:${i.code}`).sort(),
      [
        'data.__proto__x:UNKNOWN_FIELD',
        'data.alien:UNKNOWN_FIELD',
        'data.nome:REQUIRED',
        'data.ref:READ_ONLY',
      ].sort()
    )
    assert.equal(validateRecordData(fields, [], null).issues[0].code, 'INVALID_DATA')
  })

  test('alteração parcial: null apaga, obrigatório não se apaga, arquivado não aceita escritas', ({
    assert,
  }) => {
    const fields = [
      field({ code: 'nome', type: 'TEXT', required: true }),
      field({ code: 'nota', type: 'TEXT' }),
      { ...field({ code: 'velho', type: 'TEXT' }), archived: true },
    ]
    const previous = { nome: 'Ana', nota: 'x', velho: 'legado' }
    assert.deepEqual(validateRecordData(fields, { nota: null }, previous).values, {
      nome: 'Ana',
      velho: 'legado',
    })
    assert.equal(validateRecordData(fields, { nome: null }, previous).issues[0].code, 'REQUIRED')
    assert.equal(
      validateRecordData(fields, { velho: 'novo' }, previous).issues[0].code,
      'ARCHIVED_FIELD'
    )
  })

  test('dados com mais de 64 KB são recusados', ({ assert }) => {
    const fields = [field({ code: 'nota', type: 'TEXTAREA' })]
    const result = validateRecordData(
      fields,
      { nota: 'x'.repeat(9000), b: 'y'.repeat(60000) },
      null
    )
    assert.equal(result.issues[0].code, 'DATA_TOO_LARGE')
  })

  test('únicos, referências, pesquisa e separação de sensíveis', ({ assert }) => {
    const fields = [
      field({ code: 'nif', type: 'TEXT', validation: { unique: true } }),
      field({ code: 'nome', type: 'TEXT' }),
      field({ code: 'segredo', type: 'TEXT', sensitive: true }),
      field({ code: 'cor', type: 'SELECT', options: [{ code: 'red', label: 'Vermelho' }] }),
      field({ code: 'dono', type: 'USER_REFERENCE' }),
    ]
    const values = {
      nif: ' AB-1 ',
      nome: 'Ana Maria',
      segredo: 'confidencial',
      cor: 'red',
      dono: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    }
    assert.deepEqual(uniqueKeys(fields, values), [{ fieldCode: 'nif', key: 'ab-1' }])
    assert.deepEqual(
      collectReferences(fields, values).map((r) => [r.kind, r.path]),
      [['USER', 'data.dono']]
    )
    const search = searchText(fields, values)
    assert.include(search, 'ana maria')
    assert.include(search, 'vermelho')
    assert.notInclude(search, 'confidencial')
    const { data, sensitive } = partition(fields, values)
    assert.deepEqual(sensitive, { segredo: 'confidencial' })
    assert.notProperty(data, 'segredo')
  })
})

test.group('metadados | compatibilidade entre versões publicadas', () => {
  const base = [
    field({
      code: 'nome',
      type: 'TEXT',
      required: true,
      defaultValue: 'x',
      validation: { maxLength: 50 },
    }),
    field({
      code: 'cor',
      type: 'SELECT',
      options: [
        { code: 'red', label: 'Vermelho' },
        { code: 'blue', label: 'Azul' },
      ],
    }),
    field({
      code: 'peso',
      type: 'DECIMAL',
      validation: { precision: 10, scale: 2, max: '100.00' },
    }),
    field({ code: 'dica', type: 'TEXT', sensitive: true }),
  ]
  const codes = (next: FieldSpec[]) =>
    checkCompatibility(base, next).issues.map((i) => `${i.path}:${i.code}`)
  const patch = (code: string, change: Partial<FieldSpec>) =>
    base.map((f) => (f.code === code ? { ...f, ...change } : f))

  test('sem alterações é compatível', ({ assert }) => {
    const report = checkCompatibility(base, base)
    assert.isEmpty(report.issues)
    assert.isEmpty(report.added)
    assert.isEmpty(report.removed)
  })

  test('campos retirados e opções retiradas ficam arquivados, nunca apagados', ({ assert }) => {
    const next = patch('cor', { options: [{ code: 'red', label: 'Vermelho' }] }).filter(
      (f) => f.code !== 'peso'
    )
    const report = checkCompatibility(base, next)
    assert.isEmpty(report.issues)
    assert.deepEqual(report.removed, ['peso'])
    assert.isTrue(report.effective.find((f) => f.code === 'peso')?.archived)
    const cor = report.effective.find((f) => f.code === 'cor')!
    assert.deepInclude(
      cor.options.find((o) => o.code === 'blue'),
      { archived: true, label: 'Azul' }
    )
  })

  test('mudança de tipo, de destino, de sensibilidade ou reutilização de código retirado bloqueiam', ({
    assert,
  }) => {
    assert.include(codes(patch('nome', { type: 'TEXTAREA' })), 'fields.nome:FIELD_TYPE_CHANGED')
    assert.include(codes(patch('dica', { sensitive: false })), 'fields.dica:SENSITIVE_CHANGED')
    assert.include(codes(patch('nome', { sensitive: true })), 'fields.nome:SENSITIVE_CHANGED')
    const retired = [{ ...base[0], archived: true }]
    const report = checkCompatibility(retired, [base[0]])
    assert.equal(report.issues[0].code, 'FIELD_CODE_RETIRED')
  })

  test('novo obrigatório sem omissão, tornar obrigatório e tornar único bloqueiam', ({
    assert,
  }) => {
    const added = field({ code: 'novo', type: 'TEXT', required: true })
    assert.include(codes([...base, added]), 'fields.novo:REQUIRED_WITHOUT_DEFAULT')
    assert.isEmpty(codes([...base, { ...added, defaultValue: 'ok' }]))
    assert.include(codes(patch('peso', { required: true })), 'fields.peso:REQUIRED_WITHOUT_DEFAULT')
    assert.include(
      codes(patch('dica', { validation: { unique: true } })),
      'fields.dica:UNIQUE_ON_EXISTING'
    )
  })

  test('restringir limites bloqueia; relaxar não', ({ assert }) => {
    assert.include(
      codes(patch('nome', { validation: { maxLength: 10 } })),
      'fields.nome:CONSTRAINT_TIGHTENED'
    )
    assert.include(
      codes(patch('nome', { validation: { maxLength: 50, minLength: 3 } })),
      'fields.nome:CONSTRAINT_TIGHTENED'
    )
    assert.include(
      codes(patch('nome', { validation: { maxLength: 50, pattern: '^a' } })),
      'fields.nome:CONSTRAINT_TIGHTENED'
    )
    assert.include(
      codes(patch('peso', { validation: { precision: 10, scale: 2, max: '99.00' } })),
      'fields.peso:CONSTRAINT_TIGHTENED'
    )
    assert.include(
      codes(patch('peso', { validation: { precision: 10, scale: 3, max: '100.000' } })),
      'fields.peso:CONSTRAINT_TIGHTENED'
    )
    assert.isEmpty(codes(patch('nome', { validation: { maxLength: 200 } })))
    assert.isEmpty(codes(patch('peso', { validation: { precision: 10, scale: 2, max: '500.00' } })))
    assert.isEmpty(codes(patch('peso', { validation: { precision: 10, scale: 2 } })))
  })
})
