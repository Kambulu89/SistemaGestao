import { test } from '@japa/runner'
import {
  inTransit,
  normalizeReturnLine,
  normalizeTransferLine,
  returnable,
  statusAfterReceiving,
  variance,
} from '#modules/inventory/domain/logistics'
import type { Issue } from '#modules/inventory/domain/stock'

const issuesOf = (run: (issues: Issue[]) => unknown) => {
  const issues: Issue[] = []
  run(issues)
  return issues.map((i) => `${i.path}:${i.code}`)
}

test.group('logística | aritmética do domínio', () => {
  test('o que está em trânsito é o expedido menos o recebido, nunca negativo', ({ assert }) => {
    assert.equal(inTransit('30.000000', '12.000000'), '18.000000')
    assert.equal(inTransit('30.000000', '30.000000'), '0.000000')
    assert.equal(inTransit('0.000000', '0.000000'), '0.000000')
    assert.equal(inTransit('1.000000', '2.000000'), '0.000000')
  })

  test('só está recebida quando nenhuma linha tem stock em trânsito', ({ assert }) => {
    const done = { dispatchedQty: '5.000000', receivedQty: '5.000000' }
    const half = { dispatchedQty: '5.000000', receivedQty: '2.500000' }
    assert.equal(statusAfterReceiving([done, done]), 'RECEIVED')
    assert.equal(statusAfterReceiving([done, half]), 'PARTIAL_RECEIVED')
    assert.equal(statusAfterReceiving([half]), 'PARTIAL_RECEIVED')
  })

  test('a variação da contagem é contado − esperado; sem contagem não há variação', ({
    assert,
  }) => {
    assert.equal(variance('100.000000', '97.500000'), '-2.500000')
    assert.equal(variance('0.000000', '2.000000'), '2.000000')
    assert.equal(variance('5.000000', '5.000000'), '0.000000')
    assert.isNull(variance('5.000000', null))
  })

  test('o devolvível é o líquido da origem menos o já devolvido', ({ assert }) => {
    assert.equal(returnable('10.000000', '4.000000'), '6.000000')
    assert.equal(returnable('10.000000', '10.000000'), '0.000000')
    assert.equal(returnable('10.000000', '12.000000'), '0.000000')
  })
})

test.group('logística | validação das linhas', () => {
  test('linha de transferência: variante, quantidade positiva e referências', ({ assert }) => {
    assert.deepEqual(
      issuesOf((i) => normalizeTransferLine({ quantity: '0' }, 'l', i)),
      ['l.variantId:REQUIRED', 'l.quantity:INVALID_QUANTITY']
    )
    assert.deepEqual(
      issuesOf((i) => normalizeTransferLine({ variantId: 'v', quantity: '1.1234567' }, 'l', i)),
      ['l.quantity:INVALID_QUANTITY']
    )
    assert.deepEqual(
      issuesOf((i) => normalizeTransferLine({ variantId: 'v', quantity: '1', lotId: 5 }, 'l', i)),
      ['l.lotId:INVALID_REFERENCE']
    )
    const ok = normalizeTransferLine({ variantId: 'v', quantity: '2.5' }, 'l', [])
    assert.equal(ok?.quantity, '2.500000')
    assert.isNull(ok?.lotId)
  })

  test('linha de devolução: estado por omissão vendável e só os estados conhecidos', ({
    assert,
  }) => {
    const ok = normalizeReturnLine({ sourceLineId: 's', quantity: '1' }, 'l', [])
    assert.equal(ok?.condition, 'SELLABLE')
    assert.deepEqual(
      issuesOf((i) =>
        normalizeReturnLine({ sourceLineId: 's', quantity: '1', condition: 'LOST' }, 'l', i)
      ),
      ['l.condition:INVALID_CONDITION']
    )
    assert.deepEqual(
      issuesOf((i) => normalizeReturnLine({ quantity: '-1' }, 'l', i)),
      ['l.sourceLineId:REQUIRED', 'l.quantity:INVALID_QUANTITY']
    )
  })
})
