import { test } from '@japa/runner'
import { canOpen, pricesHidden, quoteLines, RFQ_CAN } from '#modules/procurement/domain/rfqs'

const A = '00000000-0000-4000-8000-00000000000a'
const B = '00000000-0000-4000-8000-00000000000b'
const ids = new Set([A, B])
const codes = (r: ReturnType<typeof quoteLines>) => r.issues.map((i) => `${i.path}:${i.code}`)

test.group('Compras | pedidos de cotação: regras', () => {
  test('envelope: valores ocultos só com envelope fechado e pedido aberto', ({ assert }) => {
    assert.isTrue(pricesHidden({ sealed: true, status: 'OPEN' }))
    assert.isFalse(pricesHidden({ sealed: true, status: 'CLOSED' }))
    assert.isFalse(pricesHidden({ sealed: false, status: 'OPEN' }))
    assert.isFalse(pricesHidden({ sealed: true, status: 'DRAFT' }))
  })

  test('abertura: depois do prazo sempre; antes só com todos respondidos ou declinados', ({
    assert,
  }) => {
    const closes = new Date('2026-06-10T12:00:00Z')
    const before = new Date('2026-06-10T11:59:59Z')
    assert.isTrue(canOpen(closes, closes, [{ status: 'INVITED' }]))
    assert.isFalse(canOpen(closes, before, [{ status: 'RESPONDED' }, { status: 'INVITED' }]))
    assert.isTrue(canOpen(closes, before, [{ status: 'RESPONDED' }, { status: 'DECLINED' }]))
    assert.isFalse(canOpen(closes, before, []))
  })

  test('fases: só o rascunho se edita; só o aberto recebe propostas; adjudicado não se anula', ({
    assert,
  }) => {
    assert.deepEqual(RFQ_CAN.edit, ['DRAFT'])
    assert.deepEqual(RFQ_CAN.quote, ['OPEN'])
    assert.notInclude(RFQ_CAN.cancel, 'AWARDED')
  })

  test('linhas da proposta: totais exactos só das ofertas principais; alternativas descritas', ({
    assert,
  }) => {
    const r = quoteLines(
      [
        { rfqLineId: A, quantity: '3', unitPrice: '0.333333', taxRate: '14' },
        {
          rfqLineId: A,
          alternativeNo: 2,
          description: 'Equivalente',
          quantity: '3',
          unitPrice: '5',
        },
        { rfqLineId: B, quantity: '1.5', unitPrice: '100.01', taxRate: '7' },
      ],
      ids
    )
    assert.deepEqual(r.issues, [])
    assert.deepEqual(
      r.amounts.map((a) => [a.net, a.tax]),
      [
        [100n, 14n],
        [1500n, 0n],
        [15002n, 1050n],
      ]
    )
    assert.deepEqual(r.totals, { net: 15102n, tax: 1064n, total: 16166n })
  })

  test('linhas da proposta: validações', ({ assert }) => {
    assert.include(codes(quoteLines([], ids)), 'lines:REQUIRED')
    const r = quoteLines(
      [
        { rfqLineId: 'x', quantity: '1', unitPrice: '1' },
        { rfqLineId: A, alternativeNo: 1, quantity: '0', unitPrice: '-1', taxRate: '101' },
        { rfqLineId: B, quantity: '-1.5', unitPrice: '1' },
        { rfqLineId: B, quantity: '1', unitPrice: '1', alternativeNo: 0, deliveryDays: 1000 },
        { rfqLineId: A, alternativeNo: 10, quantity: '1', unitPrice: '1', description: 'x' },
      ],
      ids
    )
    assert.includeMembers(codes(r), [
      'lines.0.rfqLineId:NOT_FOUND',
      'lines.1.description:REQUIRED',
      'lines.1.quantity:INVALID',
      'lines.1.unitPrice:INVALID',
      'lines.1.taxRate:INVALID',
      'lines.2.quantity:INVALID',
      'lines.3.alternativeNo:DUPLICATE',
      'lines.3.deliveryDays:INVALID',
      'lines.4.alternativeNo:INVALID',
    ])
  })
})
