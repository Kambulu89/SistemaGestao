import { test } from '@japa/runner'
import {
  checkMachine,
  conditionVariables,
  normalizeStates,
  normalizeTransitions,
  transitionsFrom,
  type MachineIssue,
} from '#dynamic/states/domain/state_machine'

const raw = (code: string, category: string, extra: Record<string, unknown> = {}) => ({
  code,
  label: code,
  category,
  ...extra,
})

test.group('estados | domínio', () => {
  test('categorias definem a edição por omissão; o que se escreve é normalizado', ({ assert }) => {
    const issues: MachineIssue[] = []
    const states = normalizeStates(
      [
        raw('aberto', 'INITIAL'),
        raw('em_curso', 'ACTIVE'),
        raw('feito', 'FINAL'),
        raw('revisto', 'FINAL', { editable: true, color: 'success' }),
        { ...raw('anulado', 'CANCELLED'), label: '  Anulado  ' },
      ],
      issues
    )
    assert.deepEqual(issues, [])
    assert.deepEqual(
      states.map((s) => [s.code, s.editable]),
      [
        ['aberto', true],
        ['em_curso', true],
        ['feito', false],
        ['revisto', true],
        ['anulado', false],
      ]
    )
    assert.equal(states[4].label, 'Anulado')
    assert.equal(states[3].color, 'success')
  })

  test('estados e transições mal formados são recusados com o caminho', ({ assert }) => {
    const issues: MachineIssue[] = []
    normalizeStates([raw('A', 'INITIAL'), raw('ok', 'ESTRANHO'), { code: 'x_y', extra: 1 }], issues)
    assert.sameMembers(
      issues.map((i) => `${i.path}:${i.code}`),
      [
        'states[0].code:INVALID_CODE',
        'states[1].category:INVALID_CATEGORY',
        'states[2].extra:UNKNOWN_KEY',
        'states[2].label:INVALID_LABEL',
        'states[2].category:INVALID_CATEGORY',
      ]
    )
    const bad: MachineIssue[] = []
    normalizeTransitions(
      [
        { code: 'a_b', label: 'X', from: [], to: 'dest' },
        { code: 'a_b', label: 'Y', from: ['x_y', 'x_y'], to: 3 },
        { code: 'c_d', label: 'Z', from: ['x_y'], to: 'dest', guard: 'sim' },
      ],
      bad
    )
    assert.sameMembers(
      bad.map((i) => `${i.path}:${i.code}`),
      [
        'transitions[0].from:INVALID_FROM',
        'transitions[1].code:DUPLICATE_TRANSITION',
        'transitions[1].from:INVALID_FROM',
        'transitions[1].to:INVALID_TO',
        'transitions[2].guard:INVALID_GUARD',
      ]
    )
  })

  test('integridade: um só estado inicial, alcançabilidade e saídas de estados finais', ({
    assert,
  }) => {
    const issues: MachineIssue[] = []
    const states = normalizeStates(
      [
        raw('aberto', 'INITIAL'),
        raw('em_curso', 'ACTIVE'),
        raw('feito', 'FINAL'),
        raw('perdido', 'ACTIVE'),
      ],
      issues
    )
    const transitions = normalizeTransitions(
      [
        { code: 'iniciar', label: 'Iniciar', from: ['aberto'], to: 'em_curso' },
        { code: 'fechar', label: 'Fechar', from: ['em_curso'], to: 'feito' },
      ],
      issues
    )
    assert.deepEqual(
      checkMachine(states, transitions).map((i) => `${i.path}:${i.code}`),
      ['states[3]:UNREACHABLE_STATE']
    )
    const withExit = normalizeTransitions(
      [...transitions, { code: 'reabrir', label: 'Reabrir', from: ['feito'], to: 'em_curso' }],
      issues
    )
    assert.include(
      checkMachine(states, withExit).map((i) => i.code),
      'TRANSITION_FROM_FINAL'
    )
    assert.include(
      checkMachine([], []).map((i) => i.code),
      'INITIAL_STATE'
    )
  })

  test('variáveis das guardas e transições a partir de um estado', ({ assert }) => {
    assert.sameMembers(
      conditionVariables({
        op: 'and',
        args: [
          { op: 'gt', left: { var: 'resource.qtd' }, right: { value: 0 } },
          { op: 'eq', left: { var: 'subject.userId' }, right: { var: 'resource.dono' } },
        ],
      }),
      ['resource.qtd', 'subject.userId', 'resource.dono']
    )
    const issues: MachineIssue[] = []
    const transitions = normalizeTransitions(
      [
        { code: 'a_b', label: 'A', from: ['x_1'], to: 'y_1' },
        { code: 'c_d', label: 'C', from: ['x_1', 'z_1'], to: 'y_1' },
      ],
      issues
    )
    assert.deepEqual(
      transitionsFrom(transitions, 'z_1').map((t) => t.code),
      ['c_d']
    )
    assert.deepEqual(
      transitionsFrom(transitions, 'x_1').map((t) => t.code),
      ['a_b', 'c_d']
    )
  })
})
