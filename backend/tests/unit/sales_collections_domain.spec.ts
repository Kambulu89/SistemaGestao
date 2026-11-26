import { test } from '@japa/runner'
import {
  aging,
  agingBucket,
  daysOverdue,
  normalizeActivity,
  normalizePromise,
  promiseStatus,
} from '#modules/sales/domain/collections'

const LE = '00000000-0000-4000-8000-000000000001'

test.group('Vendas | cobranças — regras (10.10)', () => {
  test('atraso e antiguidade nos limites dos intervalos', ({ assert }) => {
    const t = '2026-06-30'
    assert.equal(daysOverdue('2026-07-01', t), 0)
    assert.equal(daysOverdue('2026-06-30', t), 0)
    assert.deepEqual(
      [
        '2026-06-30',
        '2026-06-29',
        '2026-05-31',
        '2026-05-30',
        '2026-04-01',
        '2026-03-31',
        '2026-01-01',
      ].map((d) => agingBucket(d, t)),
      ['CURRENT', 'D1_30', 'D1_30', 'D31_60', 'D61_90', 'D90_PLUS', 'D90_PLUS']
    )
    const a = aging(
      [
        { dueDate: '2026-07-10', open: 100n },
        { dueDate: '2026-06-01', open: 250n },
        { dueDate: '2026-06-15', open: 50n },
      ],
      t
    )
    assert.deepEqual([a.CURRENT, a.D1_30, a.D31_60], [100n, 300n, 0n])
  })

  test('estado da promessa: em aberto, cumprida, falhada, anulada', ({ assert }) => {
    const base = { cancelled: false, amount: 55000n, paidSince: 0n, promisedDate: '2026-06-30' }
    assert.equal(promiseStatus({ ...base, today: '2026-06-30' }), 'OPEN')
    assert.equal(promiseStatus({ ...base, today: '2026-07-01' }), 'BROKEN')
    assert.equal(promiseStatus({ ...base, paidSince: 55000n, today: '2026-07-05' }), 'KEPT')
    assert.equal(promiseStatus({ ...base, paidSince: 54999n, today: '2026-06-01' }), 'OPEN')
    assert.equal(
      promiseStatus({ ...base, cancelled: true, paidSince: 55000n, today: '2026-06-01' }),
      'CANCELLED'
    )
  })

  test('validação de promessas e contactos', ({ assert }) => {
    const p = normalizePromise(
      { amount: '0', promisedDate: '2026-01-01', invoiceIds: ['x'] },
      '2026-06-30'
    )
    assert.includeMembers(
      p.issues.map((i) => i.path),
      ['amount', 'promisedDate', 'legalEntityId', 'invoiceIds']
    )
    const ok = normalizePromise(
      { amount: '12.50', promisedDate: '2026-07-01', legalEntityId: LE },
      '2026-06-30'
    )
    assert.deepEqual([ok.issues, ok.v.amount], [[], 1250n])
    const a = normalizeActivity(
      { kind: 'SMS', outcome: 'X', notes: 'ab', nextActionDate: '2026-01-01' },
      '2026-06-30'
    )
    assert.includeMembers(
      a.issues.map((i) => i.path),
      ['kind', 'outcome', 'legalEntityId', 'notes', 'nextActionDate']
    )
  })
})
