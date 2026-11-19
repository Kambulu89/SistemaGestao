import { test } from '@japa/runner'
import {
  accountingEvent,
  classKey,
  costAdjustmentEvent,
  eventAmounts,
  reversalEvent,
} from '#modules/inventory/domain/integrations'

test.group('Inventário | domínio das integrações (8.10)', () => {
  test('evento contabilístico pelo tipo, origem e sentido', ({ assert }) => {
    const e = (
      type: string,
      sourceType: string,
      direction: 'IN' | 'OUT',
      documentOrigin?: string
    ) => accountingEvent({ type, sourceType, direction, documentOrigin })
    assert.equal(e('RECEIPT', 'PURCHASE_RECEIPT', 'IN'), 'RECEIPT_PURCHASE')
    assert.equal(e('RECEIPT', 'STOCK_DOCUMENT', 'IN', 'OPENING'), 'RECEIPT_OPENING')
    assert.equal(e('RECEIPT', 'SALES_RETURN', 'IN'), 'RECEIPT_RETURN')
    assert.equal(e('ISSUE', 'SALES_DELIVERY', 'OUT'), 'ISSUE_SALE')
    assert.equal(e('ISSUE', 'INTERNAL_REQUISITION', 'OUT'), 'ISSUE_CONSUMPTION')
    assert.equal(e('ISSUE', 'STOCK_DOCUMENT', 'OUT', 'LOSS'), 'ISSUE_LOSS')
    assert.equal(e('ISSUE', 'TEST', 'OUT'), 'ISSUE_OTHER')
    assert.equal(e('ADJUSTMENT', 'STOCK_COUNT', 'IN'), 'ADJUSTMENT_GAIN')
    assert.equal(e('ADJUSTMENT', 'STOCK_COUNT', 'OUT'), 'ADJUSTMENT_LOSS')
    assert.equal(e('TRANSFER_OUT', 'INTERCOMPANY_TRANSFER', 'OUT'), 'TRANSFER_OUT_INTERCOMPANY')
    assert.equal(e('TRANSFER_OUT', 'INTERCOMPANY_TRANSFER', 'IN'), 'TRANSFER_IN_INTERCOMPANY')
    assert.equal(reversalEvent('ISSUE_SALE'), 'REV_ISSUE_SALE')
    assert.isAtMost(reversalEvent('X'.repeat(40)).length, 40)
    assert.equal(costAdjustmentEvent('OUT'), 'COST_ADJUSTMENT_DOWN')
  })

  test('montantes: total e todas as classes (as que não se movem a zero)', ({ assert }) => {
    const { amounts, total } = eventAmounts(
      new Map([
        ['MERCADORIAS', 12345n],
        ['SEM_CLASSE', 5n],
      ]),
      ['MERCADORIAS', 'MATERIAS']
    )
    assert.equal(total, 12350n)
    assert.deepEqual(amounts, {
      value: '123.50',
      cls_mercadorias: '123.45',
      cls_materias: '0.00',
      cls_sem_classe: '0.05',
    })
    assert.equal(classKey('PRODUTOS_ACABADOS'), 'cls_produtos_acabados')
  })
})
