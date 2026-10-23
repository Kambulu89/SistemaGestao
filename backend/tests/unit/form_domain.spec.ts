import { test } from '@japa/runner'
import {
  checkFormAgainstFields,
  conditionFields,
  normalizeCondition,
  normalizeModes,
  normalizeSections,
  type FormFieldInfo,
  type FormIssue,
  type FormMode,
} from '#dynamic/forms/domain/form'

const info = (code: string, extra: Partial<FormFieldInfo> = {}): FormFieldInfo => ({
  code,
  required: false,
  readOnly: false,
  sensitive: false,
  archived: false,
  defaultValue: null,
  ...extra,
})

test.group('formulários | domínio', () => {
  test('condições: operadores conhecidos, valores simples e limites; «in» exige valores', ({
    assert,
  }) => {
    const issues: FormIssue[] = []
    const condition = normalizeCondition(
      {
        op: 'and',
        conditions: [
          { op: 'eq', field: 'tipo', value: 'camiao', extra: 'ignorado' },
          { op: 'in', field: 'estado', values: ['a', 'b'] },
          { op: 'not', condition: { op: 'empty', field: 'nota' } },
        ],
      },
      'c',
      issues
    )
    assert.deepEqual(issues, [])
    assert.deepEqual(conditionFields(condition!).sort(), ['estado', 'nota', 'tipo'])
    assert.notProperty((condition as any).conditions[0], 'extra')

    const bad = (raw: unknown) => {
      const found: FormIssue[] = []
      normalizeCondition(raw, 'c', found)
      return found.map((i) => i.code)
    }
    assert.deepEqual(bad({ op: 'eq', field: 'tipo', value: { a: 1 } }), ['INVALID_CONDITION_VALUE'])
    assert.deepEqual(bad({ op: 'in', field: 'tipo', values: [] }), ['INVALID_CONDITION_VALUE'])
    assert.deepEqual(bad({ op: 'and', conditions: [] }), ['INVALID_CONDITION'])
    assert.deepEqual(bad({ op: 'js', code: '1' }), ['UNKNOWN_OP'])
    assert.deepEqual(bad({ op: 'eq', field: 'Tipo!', value: 1 }), ['INVALID_CONDITION_FIELD'])
    assert.deepEqual(bad('x'), ['INVALID_CONDITION'])
    const wide = {
      op: 'and',
      conditions: Array.from({ length: 60 }, () => ({ op: 'empty', field: 'a' })),
    }
    assert.include(bad(wide), 'CONDITION_TOO_LARGE')
  })

  test('secções: normaliza e recusa chaves desconhecidas, colunas e secções repetidas', ({
    assert,
  }) => {
    const issues: FormIssue[] = []
    const sections = normalizeSections(
      [
        {
          key: 'dados',
          title: ' Dados ',
          items: [{ kind: 'field', field: 'marca', span: 2, help: ' ajuda ' }],
        },
      ],
      issues
    )
    assert.deepEqual(issues, [])
    assert.equal(sections[0].title, 'Dados')
    assert.equal(sections[0].columns, 1)
    assert.equal(sections[0].items[0].help, 'ajuda')

    const bad: FormIssue[] = []
    normalizeSections([{ key: 'A', title: '', columns: 0, items: 'x', extra: 1 }], bad)
    assert.sameMembers(
      bad.map((i) => i.code),
      ['INVALID_CODE', 'INVALID_TITLE', 'INVALID_COLUMNS', 'INVALID_ITEMS', 'UNKNOWN_KEY']
    )
  })

  test('modos: sem repetir e só os conhecidos, por ordem canónica', ({ assert }) => {
    const issues: FormIssue[] = []
    assert.deepEqual(normalizeModes(['read', 'create'], issues), ['create', 'read'])
    assert.deepEqual(issues, [])
    normalizeModes(['delete'], issues)
    assert.equal(issues[0].code, 'INVALID_MODES')
  })

  test('verificação contra a entidade: obrigatórios, escondidos e campos arquivados', ({
    assert,
  }) => {
    const fields = [
      info('matricula', { required: true }),
      info('marca'),
      info('antiga', { archived: true }),
      info('codigo', { required: true, defaultValue: 'X' }),
    ]
    const codes = (sections: unknown[], modes: FormMode[] = ['create', 'edit', 'read']) => {
      const issues: FormIssue[] = []
      const normalized = normalizeSections(sections, issues)
      assert.deepEqual(issues, [])
      return checkFormAgainstFields(normalized, modes, fields).map((i) => i.code)
    }
    const item = (field: string, extra = {}) => ({ kind: 'field', field, ...extra })
    assert.deepEqual(codes([{ key: 'a', title: 'A', items: [item('matricula')] }]), [])
    assert.deepEqual(codes([{ key: 'a', title: 'A', items: [item('marca')] }]), [
      'FORM_MISSING_REQUIRED',
    ])
    assert.deepEqual(
      codes([{ key: 'a', title: 'A', items: [item('matricula'), item('antiga')] }]),
      ['FORM_UNKNOWN_FIELD']
    )
    assert.deepEqual(
      codes([{ key: 'a', title: 'A', items: [item('matricula', { visible: false })] }]),
      ['FORM_HIDES_REQUIRED']
    )
    // Um formulário só de consulta não precisa dos obrigatórios nem de os mostrar.
    assert.deepEqual(codes([{ key: 'a', title: 'A', items: [item('marca')] }], ['read']), [])
  })
})
