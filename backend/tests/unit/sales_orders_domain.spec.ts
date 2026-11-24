import { test } from '@japa/runner'
import {
  creditCheck,
  deliveryStatus,
  invoicingStatus,
  normalizeDelivery,
  normalizeOrderHeader,
  normalizeQtyRequest,
  openQty,
  reservationStatus,
} from '#modules/sales/domain/orders'

const paths = (issues: { path: string }[]) => issues.map((i) => i.path)
const L = (
  x: Partial<Record<'quantity' | 'reserved' | 'delivered' | 'invoiced' | 'closed', string>>,
  isStock = true
) => ({
  isStock,
  quantity: '10',
  reserved: '0',
  delivered: '0',
  invoiced: '0',
  closed: '0',
  ...x,
})

test.group('Vendas | encomendas — regras (10.4)', () => {
  test('cabeçalho: obrigatórios e datas', ({ assert }) => {
    assert.includeMembers(paths(normalizeOrderHeader({}, true).issues), [
      'legalEntityId',
      'customerId',
      'orderDate',
    ])
    assert.include(
      paths(
        normalizeOrderHeader({ orderDate: '2026-05-10', requestedDate: '2026-05-01' }, false).issues
      ),
      'requestedDate'
    )
    assert.deepEqual(normalizeOrderHeader({ warehouseId: '', currency: 'usd' }, false).v, {
      warehouseId: null,
      currency: 'USD',
    })
  })

  test('estados derivados das quantidades', ({ assert }) => {
    assert.equal(openQty(L({ delivered: '3', closed: '2' })), 5_000_000n)
    assert.equal(reservationStatus([L({}, false)]), 'NOT_APPLICABLE')
    assert.equal(reservationStatus([L({})]), 'NONE')
    assert.equal(reservationStatus([L({ reserved: '4' })]), 'PARTIAL')
    assert.equal(reservationStatus([L({ reserved: '7', delivered: '3' }), L({}, false)]), 'FULL')
    assert.equal(deliveryStatus([L({})]), 'NONE')
    assert.equal(deliveryStatus([L({ delivered: '10' }), L({ delivered: '1' })]), 'PARTIAL')
    assert.equal(deliveryStatus([L({ delivered: '10' })]), 'FULL')
    assert.equal(invoicingStatus([L({})]), 'NONE')
    assert.equal(invoicingStatus([L({ invoiced: '8', closed: '2' })]), 'FULL')
    assert.equal(invoicingStatus([L({ invoiced: '5' })]), 'PARTIAL')
  })

  test('limite de crédito: sem limite não há verificação; exposição inclui as encomendas em aberto', ({
    assert,
  }) => {
    assert.isFalse(creditCheck(null, 900_00n, 900_00n).exceeded)
    const c = creditCheck(1000_00n, 456_00n, 456_00n)
    assert.deepEqual(c, {
      limit: '1000.00',
      openOrders: '456.00',
      thisOrder: '456.00',
      exposure: '912.00',
      exceeded: false,
    })
    assert.isTrue(creditCheck(1000_00n, 600_00n, 400_01n).exceeded)
    assert.isFalse(creditCheck(1000_00n, 600_00n, 400_00n).exceeded)
  })

  test('pedidos de expedição e de reserva', ({ assert }) => {
    assert.includeMembers(paths(normalizeDelivery({ requestKey: 'x', lines: [] }).issues), [
      'requestKey',
      'deliveryDate',
      'lines',
    ])
    const d = normalizeDelivery({
      requestKey: 'entrega-01',
      deliveryDate: '2026-05-10',
      lines: [
        { lineId: '00000000-0000-4000-8000-000000000001', quantity: '1,5', serials: [' S1 ', ''] },
      ],
    })
    assert.deepEqual(d.issues, [])
    assert.deepEqual(d.lines[0].serials, ['S1'])
    assert.equal(d.lines[0].quantity, 1_500_000n)
    assert.deepEqual(normalizeQtyRequest({}).lines, [])
    assert.include(
      paths(normalizeQtyRequest({ lines: [{ lineId: 'x', quantity: '0' }] }).issues),
      'lines.0.quantity'
    )
  })
})
