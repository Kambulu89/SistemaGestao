import { test } from '@japa/runner'
import { buildTrialBalance, type TbAccount } from '#modules/accounting/domain/trial_balance'

const acc = (id: string, code: string, parentId: string | null, postable: boolean): TbAccount => ({
  id,
  code,
  name: `Conta ${code}`,
  parentId,
  level: parentId ? 'ACCOUNT' : 'CLASS',
  postable,
})
const accounts = [
  acc('c1', '1', null, false),
  acc('a11', '11', 'c1', false),
  acc('a111', '111', 'a11', true),
  acc('a112', '112', 'a11', true),
  acc('c7', '7', null, false),
  acc('a71', '71', 'c7', true),
]
const amounts = new Map([
  ['a111', { opening: 1000n, debit: 500n, credit: 200n }],
  ['a112', { opening: 0n, debit: 300n, credit: 0n }],
  ['a71', { opening: -1000n, debit: 0n, credit: 600n }],
])

test.group('contabilidade | balancete (puro)', () => {
  test('analítico: contas-mãe somam os filhos, totais só das folhas (sem duplicar)', ({
    assert,
  }) => {
    const tb = buildTrialBalance(accounts, amounts, { mode: 'analytic' })
    assert.deepEqual(
      tb.rows.map((r) => [r.code, r.depth, r.debit, r.credit, r.closing]),
      [
        ['1', 1, 800n, 200n, 1600n],
        ['11', 2, 800n, 200n, 1600n],
        ['111', 3, 500n, 200n, 1300n],
        ['112', 3, 300n, 0n, 300n],
        ['7', 1, 0n, 600n, -1600n],
        ['71', 2, 0n, 600n, -1600n],
      ]
    )
    assert.deepEqual(tb.totals, {
      opening: 0n,
      debit: 800n,
      credit: 800n,
      closingDebit: 1600n,
      closingCredit: 1600n,
    })
    assert.isTrue(tb.balanced)
  })

  test('sintético até às classes; contas sem movimentos omitidas salvo pedido', ({ assert }) => {
    const tb = buildTrialBalance(accounts, amounts, { mode: 'synthetic', maxDepth: 1 })
    assert.deepEqual(
      tb.rows.map((r) => r.code),
      ['1', '7']
    )
    const withZero = buildTrialBalance([...accounts, acc('a72', '72', 'c7', true)], amounts, {
      mode: 'analytic',
      includeZero: true,
    })
    assert.include(
      withZero.rows.map((r) => r.code),
      '72'
    )
    assert.notInclude(
      buildTrialBalance([...accounts, acc('a72', '72', 'c7', true)], amounts, {
        mode: 'analytic',
      }).rows.map((r) => r.code),
      '72'
    )
  })

  test('desequilíbrio é assinalado', ({ assert }) => {
    const tb = buildTrialBalance(
      accounts,
      new Map([['a111', { opening: 0n, debit: 5n, credit: 0n }]]),
      { mode: 'analytic' }
    )
    assert.isFalse(tb.balanced)
  })
})
