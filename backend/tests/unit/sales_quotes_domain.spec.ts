import { test } from '@japa/runner'
import {
  CAN,
  isExpired,
  lineTotals,
  normalizeDecision,
  normalizeHeader,
  normalizeLines,
  normalizeSend,
  sum,
} from '#modules/sales/domain/quotes'

const paths = (issues: { path: string }[]) => issues.map((i) => i.path)
const P = '00000000-0000-4000-8000-000000000001'

test.group('Vendas | orçamentos — regras (10.3)', () => {
  test('cabeçalho: obrigatórios, datas e validade', ({ assert }) => {
    assert.includeMembers(paths(normalizeHeader({}, true).issues), [
      'legalEntityId',
      'customerId',
      'quoteDate',
      'validUntil',
    ])
    assert.include(
      paths(normalizeHeader({ quoteDate: '2026-05-10', validUntil: '2026-05-01' }, false).issues),
      'validUntil'
    )
    const ok = normalizeHeader({ currency: 'aoa', paymentTermsDays: 30, notes: ' ' }, false)
    assert.deepEqual(ok.issues, [])
    assert.deepEqual(ok.v, { currency: 'AOA', paymentTermsDays: 30, notes: null })
  })

  test('linhas: quantidade, desconto ou preço manual, imposto e isenção', ({ assert }) => {
    const r = normalizeLines([
      { productId: P, quantity: '2,5', manualDiscountPct: '3', taxRate: '14' },
      { productId: P, quantity: '0', taxRate: '0' },
      {
        productId: 'x',
        quantity: '1',
        manualDiscountPct: '1',
        manualUnitPrice: '1',
        taxRate: '101',
      },
      { productId: P, quantity: '1', taxRate: '0', taxExemptionReason: 'Isenção de teste' },
    ])
    assert.includeMembers(paths(r.issues), [
      'lines.1.quantity',
      'lines.1.taxExemptionReason',
      'lines.2.productId',
      'lines.2.manualUnitPrice',
      'lines.2.taxRate',
    ])
    assert.deepEqual(
      r.lines.map((l) => [l.quantity, l.manualDiscountPct, l.taxRate, l.taxExemptionReason]),
      [
        ['2.500000', '3.00', '14.00', null],
        ['1.000000', null, '0.00', 'Isenção de teste'],
      ]
    )
    assert.include(paths(normalizeLines(new Array(201).fill({})).issues), 'lines')
  })

  test('imposto por linha arredondado a 2 casas e totais exactos', ({ assert }) => {
    assert.deepEqual(lineTotals('194.00', '14.00'), {
      net: '194.00',
      tax: '27.16',
      gross: '221.16',
    })
    // 0,05 × 14 % = 0,007 → 0,01 (metade para cima).
    assert.deepEqual(lineTotals('0.05', '14.00'), { net: '0.05', tax: '0.01', gross: '0.06' })
    assert.deepEqual(lineTotals(null, '14.00'), { net: '0.00', tax: '0.00', gross: '0.00' })
    assert.equal(sum(['0.10', '0.20', '1000000000000.70']), '1000000000001.00')
  })

  test('envio, decisão do cliente, transições e expiração', ({ assert }) => {
    assert.include(paths(normalizeSend({ channel: 'EMAIL' }).issues), 'sentTo')
    assert.include(paths(normalizeSend({ channel: 'FAX' }).issues), 'channel')
    assert.deepEqual(normalizeSend({ channel: 'HAND' }).issues, [])
    assert.includeMembers(paths(normalizeDecision({}, false).issues), [
      'decidedByName',
      'reason',
      'versionNo',
    ])
    assert.deepEqual(normalizeDecision({ decidedByName: 'Ana', versionNo: 2 }, true).issues, [])
    assert.notInclude(CAN.revise, 'ACCEPTED')
    assert.notInclude(CAN.cancel, 'ACCEPTED')
    assert.isTrue(isExpired('SENT', '2026-01-01', '2026-01-02'))
    assert.isFalse(isExpired('SENT', '2026-01-02', '2026-01-02'))
    assert.isFalse(isExpired('ACCEPTED', '2026-01-01', '2026-01-02'))
  })
})
