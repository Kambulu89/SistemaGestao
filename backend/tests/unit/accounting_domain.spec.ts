import { test } from '@japa/runner'
import { divRound, formatDecimal, multiply, parseDecimal } from '#modules/accounting/domain/decimal'
import {
  buildPeriods,
  checkAccountPlacement,
  checkBalancedEntry,
  normalizeLines,
  type AccountFacts,
} from '#modules/accounting/domain/accounting'

test.group('contabilidade | decimais exactos', () => {
  test('lê e escreve sem perder casas nem aceitar mais do que a escala', ({ assert }) => {
    assert.equal(parseDecimal('1234.5', 2), 123450n)
    assert.equal(parseDecimal('0.10', 1), 1n)
    assert.isNull(parseDecimal('1.234', 2))
    assert.isNull(parseDecimal('-1', 2))
    assert.isNull(parseDecimal('1e3', 2))
    assert.equal(formatDecimal(123450n, 2), '1234.50')
    assert.equal(formatDecimal(5n, 3), '0.005')
  })

  test('arredonda meio para cima e meio para o par', ({ assert }) => {
    assert.equal(divRound(25n, 10n, 'HALF_UP'), 3n)
    assert.equal(divRound(25n, 10n, 'HALF_EVEN'), 2n)
    assert.equal(divRound(35n, 10n, 'HALF_EVEN'), 4n)
    // 0.1 × 3 (taxa) em vez de float: 0.30 exacto.
    assert.equal(multiply(10n, 2, 30000000000n, 10, 2, 'HALF_UP'), 30n)
  })
})

test.group('contabilidade | regras puras', () => {
  test('hierarquia do plano: classe na raiz, código com o prefixo do pai, pai não movimentável', ({
    assert,
  }) => {
    assert.deepEqual(checkAccountPlacement({ code: '1', level: 'CLASS' }, null), [])
    assert.deepEqual(
      checkAccountPlacement(
        { code: '11', level: 'ACCOUNT' },
        { code: '1', level: 'CLASS', postable: false }
      ),
      []
    )
    const codes = (issues: { code: string }[]) => issues.map((i) => i.code)
    assert.include(
      codes(
        checkAccountPlacement(
          { code: '21', level: 'ACCOUNT' },
          { code: '1', level: 'CLASS', postable: false }
        )
      ),
      'CODE_PREFIX'
    )
    assert.include(
      codes(
        checkAccountPlacement(
          { code: '111', level: 'SUBACCOUNT' },
          { code: '11', level: 'ACCOUNT', postable: true }
        )
      ),
      'PARENT_POSTABLE'
    )
    assert.include(
      codes(checkAccountPlacement({ code: '11', level: 'ACCOUNT' }, null)),
      'PARENT_REQUIRED'
    )
  })

  test('períodos: abertura, um por mês (cortado nas datas) e regularizações', ({ assert }) => {
    const p = buildPeriods('2026-01-01', '2026-12-31')!
    assert.lengthOf(p, 14)
    assert.deepInclude(p[0], {
      kind: 'OPENING',
      number: 0,
      startDate: '2026-01-01',
      endDate: '2026-01-01',
    })
    assert.deepInclude(p[2], { kind: 'NORMAL', startDate: '2026-02-01', endDate: '2026-02-28' })
    assert.deepInclude(p[13], { kind: 'CLOSING', number: 13, startDate: '2026-12-31' })
    const irregular = buildPeriods('2026-03-15', '2027-03-31')!
    assert.deepInclude(irregular[1], { startDate: '2026-03-15', endDate: '2026-03-31' })
    assert.lengthOf(irregular, 15)
    assert.isNull(buildPeriods('2026-01-01', '2028-06-30'))
    assert.isNull(buildPeriods('2026-02-01', '2026-01-01'))
  })

  test('partidas dobradas: duas linhas, um só lado, contas movimentáveis e equilíbrio na moeda funcional', ({
    assert,
  }) => {
    const a = (id: string, extra: Partial<AccountFacts> = {}): [string, AccountFacts] => [
      id,
      {
        id,
        chartId: 'c',
        code: id,
        postable: true,
        status: 'ACTIVE',
        requiresCostCenter: false,
        requiresThirdParty: false,
        ...extra,
      },
    ]
    const uuid = (n: number) => `00000000-0000-4000-8000-00000000000${n}`
    const accounts = new Map([
      a(uuid(1)),
      a(uuid(2)),
      a(uuid(3), { postable: false }),
      a(uuid(4), { requiresCostCenter: true }),
    ])
    const conv = { rate: 10n ** 10n, scale: 2, rounding: 'HALF_UP' as const }
    const shape = normalizeLines(
      [
        { accountId: uuid(1), debit: '100', credit: '5' },
        { accountId: uuid(2), credit: '-3' },
      ],
      2
    )
    assert.sameMembers(
      shape.issues.map((i) => i.code),
      ['ONE_SIDE', 'INVALID_AMOUNT']
    )

    const ok = normalizeLines(
      [
        { accountId: uuid(1), debit: '100.10' },
        { accountId: uuid(2), credit: '100.10' },
      ],
      2
    )
    assert.deepEqual(checkBalancedEntry(ok.lines, accounts, 'c', conv).issues, [])

    const bad = normalizeLines(
      [
        { accountId: uuid(3), debit: '10' },
        { accountId: uuid(4), credit: '9' },
      ],
      2
    )
    assert.sameMembers(
      checkBalancedEntry(bad.lines, accounts, 'c', conv).issues.map((i) => i.code),
      ['NOT_POSTABLE', 'COST_CENTER_REQUIRED', 'UNBALANCED']
    )
    const single = normalizeLines([{ accountId: uuid(1), debit: '10' }], 2)
    assert.include(
      checkBalancedEntry(single.lines, accounts, 'c', conv).issues.map((i) => i.code),
      'MIN_LINES'
    )

    // 3 × 0.01 USD a 0.5: cada linha arredonda para 0.01, a contrapartida 0.03 → 0.02: desequilibra na moeda funcional.
    const fx = normalizeLines(
      [
        { accountId: uuid(1), debit: '0.01' },
        { accountId: uuid(1), debit: '0.01' },
        { accountId: uuid(1), debit: '0.01' },
        { accountId: uuid(2), credit: '0.03' },
      ],
      2
    )
    const half = { rate: 5n * 10n ** 9n, scale: 2, rounding: 'HALF_UP' as const }
    assert.include(
      checkBalancedEntry(fx.lines, accounts, 'c', half).issues.map((i) => i.code),
      'UNBALANCED_FUNCTIONAL'
    )
  })
})
