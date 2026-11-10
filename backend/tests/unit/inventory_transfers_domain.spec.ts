import { test } from '@japa/runner'
import {
  approvalComplete,
  receiveIssue,
  selfApproval,
  statusAfterReceipt,
  toShip,
  TRANSFER_CAN,
} from '#modules/inventory/domain/transfers'

test.group('Inventário | domínio das transferências (8.5)', () => {
  test('aprovação, intragrupo e segregação de funções', ({ assert }) => {
    assert.isTrue(approvalComplete({ intercompany: false, approved: true, accepted: false }))
    assert.isFalse(approvalComplete({ intercompany: true, approved: true, accepted: false }))
    assert.isFalse(approvalComplete({ intercompany: true, approved: false, accepted: true }))
    assert.isTrue(approvalComplete({ intercompany: true, approved: true, accepted: true }))
    assert.isTrue(selfApproval('u1', 'u1'))
    assert.isFalse(selfApproval('u1', 'u2'))
    assert.isFalse(selfApproval(null, 'u2'))
  })

  test('expedição, recepção e estados', ({ assert }) => {
    assert.equal(toShip({ quantity: 10n, picked: null }), 10n)
    assert.equal(toShip({ quantity: 10n, picked: 7n }), 7n)
    assert.equal(toShip({ quantity: 10n, picked: 0n }), 0n)
    assert.isNull(receiveIssue(5n, 5n))
    assert.isNotNull(receiveIssue(6n, 5n))
    assert.isNotNull(receiveIssue(-1n, 5n))
    assert.equal(statusAfterReceipt([{ shipped: 10n, received: 4n, lost: 0n }]), 'PARTIAL')
    assert.equal(statusAfterReceipt([{ shipped: 10n, received: 4n, lost: 6n }]), 'RECEIVED')
    assert.equal(
      statusAfterReceipt([
        { shipped: 0n, received: 0n, lost: 0n },
        { shipped: 3n, received: 3n, lost: 0n },
      ]),
      'RECEIVED'
    )
    assert.include(TRANSFER_CAN.cancel, 'PICKED')
    assert.notInclude(TRANSFER_CAN.cancel, 'IN_TRANSIT')
    assert.deepEqual([...TRANSFER_CAN.receive], ['IN_TRANSIT', 'PARTIAL'])
  })
})
