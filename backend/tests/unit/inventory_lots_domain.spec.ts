import { test } from '@japa/runner'
import { allocateFefo, isExpired, lotUsable, PairingQueue } from '#modules/inventory/domain/lots'
import { keyOf } from '#modules/inventory/domain/stock'

const lot = (
  id: string,
  expiryDate: string | null,
  createdAt = '2026-01-01T00:00:00Z',
  status: any = 'ACTIVE'
) => ({
  id,
  status,
  expiryDate,
  createdAt,
})
const U = 1_000_000n

test.group('Inventário | domínio dos lotes (8.8)', () => {
  test('validade e uso', ({ assert }) => {
    assert.isFalse(isExpired({ expiryDate: '2026-05-10' }, '2026-05-10'))
    assert.isTrue(isExpired({ expiryDate: '2026-05-09' }, '2026-05-10'))
    assert.isFalse(isExpired({ expiryDate: null }, '2026-05-10'))
    assert.isTrue(lotUsable(lot('a', null), '2026-05-10'))
    assert.isFalse(lotUsable(lot('a', null, undefined, 'BLOCKED'), '2026-05-10'))
    assert.isFalse(lotUsable(lot('a', '2026-01-01'), '2026-05-10'))
  })

  test('FEFO: validade mais próxima, sem validade no fim, empate pela entrada, sem lote por último', ({
    assert,
  }) => {
    const cands = [
      { lot: null, quantity: 5n * U },
      { lot: lot('sem', null), quantity: 5n * U },
      { lot: lot('jun-b', '2026-06-01', '2026-02-01T00:00:00Z'), quantity: 2n * U },
      { lot: lot('jun-a', '2026-06-01', '2026-01-01T00:00:00Z'), quantity: 2n * U },
      { lot: lot('mai', '2026-05-20'), quantity: 1n * U },
      { lot: lot('velho', '2026-01-01'), quantity: 9n * U },
      { lot: lot('bloq', '2026-05-15', undefined, 'BLOCKED'), quantity: 9n * U },
    ]
    const a = allocateFefo(8n * U, cands, { onlyUsable: true, today: '2026-05-10' })
    assert.deepEqual(
      a.parts.map((p) => [p.lotId, Number(p.quantity / U)]),
      [
        ['mai', 1],
        ['jun-a', 2],
        ['jun-b', 2],
        ['sem', 3],
      ]
    )
    assert.equal(a.short, 0n)
    // Sem filtro (ex.: abate do bloqueado/expirado) entram todos, por ordem de validade.
    const all = allocateFefo(1n * U, cands, { onlyUsable: false, today: '2026-05-10' })
    assert.equal(all.parts[0].lotId, 'velho')
    // Falta.
    assert.equal(
      allocateFefo(100n * U, cands, { onlyUsable: true, today: '2026-05-10' }).short,
      85n * U
    )
  })

  test('as entradas levam os lotes e séries que saíram; a chave do saldo inclui o lote', ({
    assert,
  }) => {
    const q = new PairingQueue()
    q.push('p|', 'l1', 2n * U, ['A', 'B'])
    q.push('p|', 'l2', 1n * U, ['C'])
    const t = q.take('p|', 2n * U + U)
    assert.deepEqual(
      t.parts.map((x) => [x.lotId, Number(x.quantity / U), x.serials]),
      [
        ['l1', 2, ['A', 'B']],
        ['l2', 1, ['C']],
      ]
    )
    assert.equal(q.take('p|', U).short, U)
    const base = { warehouseId: 'w', locationId: null, productId: 'p', variantId: null }
    assert.notEqual(keyOf({ ...base, lotId: 'l1' }), keyOf({ ...base, lotId: 'l2' }))
    assert.equal(keyOf(base), keyOf({ ...base, lotId: null }))
  })
})
