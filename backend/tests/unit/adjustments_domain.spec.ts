import { test } from '@japa/runner'
import { dueMonths, evenShare, revalue } from '#modules/accounting/domain/adjustments'

const plan = (over: Partial<Parameters<typeof dueMonths>[0]>) => ({
  kind: 'RECURRING' as const,
  frequency: 'MONTHLY' as const,
  startMonth: '2026-01',
  endMonth: null,
  months: null,
  ...over,
})

test.group('contabilidade | regularizações (puro)', () => {
  test('recorrência: mensal, trimestral e anual, com e sem fim', ({ assert }) => {
    assert.deepEqual(dueMonths(plan({}), '2026-03'), ['2026-01', '2026-02', '2026-03'])
    assert.deepEqual(dueMonths(plan({ endMonth: '2026-02' }), '2026-06'), ['2026-01', '2026-02'])
    assert.deepEqual(dueMonths(plan({ frequency: 'QUARTERLY' }), '2026-12'), [
      '2026-01',
      '2026-04',
      '2026-07',
      '2026-10',
    ])
    assert.deepEqual(dueMonths(plan({ frequency: 'ANNUAL', startMonth: '2025-12' }), '2027-01'), [
      '2025-12',
      '2026-12',
    ])
    assert.deepEqual(dueMonths(plan({ startMonth: '2026-05' }), '2026-04'), [])
  })

  test('acréscimo/diferimento: N meses a partir do início, cortados no limite', ({ assert }) => {
    const p = plan({ kind: 'DEFERRAL', startMonth: '2026-11', months: 3 })
    assert.deepEqual(dueMonths(p, '2027-12'), ['2026-11', '2026-12', '2027-01'])
    assert.deepEqual(dueMonths(p, '2026-11'), ['2026-11'])
  })

  test('repartição exacta: partes que diferem no máximo uma unidade e somam o total', ({
    assert,
  }) => {
    const parts = [1, 2, 3].map((k) => evenShare(100000n, 3, k))
    assert.deepEqual(parts, [33333n, 33334n, 33333n])
    const twelve = Array.from({ length: 12 }, (_, i) => evenShare(100001n, 12, i + 1))
    assert.equal(
      twelve.reduce((a, b) => a + b, 0n),
      100001n
    )
    assert.isTrue(twelve.every((p) => p === 8333n || p === 8334n))
  })

  test('câmbio: não realizada, realizada e câmbio em falta', ({ assert }) => {
    const rates = new Map([['USD', 9500000000000n]]) // 950,0000000000
    const { results, missingRates } = revalue(
      [
        // 100 USD contabilizados a 900 → 950: +5 000,00 (não realizada)
        {
          accountId: 'a',
          currency: 'USD',
          thirdPartyRef: 'C1',
          foreign: 10000n,
          functional: 9000000n,
        },
        // fornecedor (saldo credor) −50 USD a 900 → 950: −2 500,00
        {
          accountId: 'b',
          currency: 'USD',
          thirdPartyRef: null,
          foreign: -5000n,
          functional: -4500000n,
        },
        // liquidado em moeda, resíduo funcional de 1 000,00: realizada
        { accountId: 'a', currency: 'USD', thirdPartyRef: 'C2', foreign: 0n, functional: -100000n },
        // já ao câmbio: nada
        { accountId: 'c', currency: 'USD', thirdPartyRef: null, foreign: 100n, functional: 95000n },
        {
          accountId: 'd',
          currency: 'EUR',
          thirdPartyRef: null,
          foreign: 100n,
          functional: 100000n,
        },
      ],
      rates,
      2,
      10,
      'HALF_UP'
    )
    assert.deepEqual(
      results.map((r) => [r.accountId, r.kind, r.difference]),
      [
        ['a', 'UNREALIZED', 500000n],
        ['b', 'UNREALIZED', -250000n],
        ['a', 'REALIZED', 100000n],
      ]
    )
    assert.equal(results[0].functionalAfter, 9500000n)
    assert.deepEqual(missingRates, ['EUR'])
  })
})
