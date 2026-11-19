import { test } from '@japa/runner'
import {
  approvalIssues,
  COUNT_CAN,
  countDifference,
  seesBook,
  splitAdjustment,
} from '#modules/inventory/domain/counts'

const q = (unrestricted: bigint, quarantine = 0n, blocked = 0n) => ({
  unrestricted,
  quarantine,
  blocked,
})

test.group('Inventário | domínio das contagens (8.7)', () => {
  test('diferença e repartição do ajuste pelos baldes físicos', ({ assert }) => {
    assert.isNull(countDifference({ snapshot: 5n, counted: null }))
    assert.equal(countDifference({ snapshot: 5n, counted: 3n }), -2n)
    assert.deepEqual(splitAdjustment(0n, q(1n)), { parts: [], shortfall: 0n })
    // Sobras entram no livre.
    assert.deepEqual(splitAdjustment(4n, q(0n)), {
      parts: [{ bucket: 'UNRESTRICTED', quantity: 4n }],
      shortfall: 0n,
    })
    // Faltas: livre, depois quarentena, depois bloqueado.
    assert.deepEqual(splitAdjustment(-7n, q(3n, 2n, 5n)), {
      parts: [
        { bucket: 'UNRESTRICTED', quantity: -3n },
        { bucket: 'QUARANTINE', quantity: -2n },
        { bucket: 'BLOCKED', quantity: -2n },
      ],
      shortfall: 0n,
    })
    assert.deepEqual(splitAdjustment(-7n, q(3n)), {
      parts: [{ bucket: 'UNRESTRICTED', quantity: -3n }],
      shortfall: 4n,
    })
  })

  test('aprovação exige tudo contado e diferenças justificadas; quem vê o sistema; estados', ({
    assert,
  }) => {
    const l = (lineNo: number, snapshot: bigint, counted: bigint | null, why = false) => ({
      lineNo,
      snapshot,
      counted,
      reasonCode: why ? 'DAMAGE' : null,
      justification: why ? 'texto' : null,
    })
    assert.deepEqual(
      approvalIssues([l(1, 5n, 5n), l(2, 5n, null), l(3, 5n, 4n), l(4, 1n, 2n, true)]),
      [
        { lineNo: 2, code: 'NOT_COUNTED' },
        { lineNo: 3, code: 'NOT_JUSTIFIED' },
      ]
    )
    assert.isFalse(seesBook({ blind: true, status: 'COUNTING' }, false))
    assert.isFalse(seesBook({ blind: true, status: 'REVIEW' }, false))
    assert.isTrue(seesBook({ blind: true, status: 'REVIEW' }, true))
    assert.isTrue(seesBook({ blind: true, status: 'APPROVED' }, false))
    assert.isTrue(seesBook({ blind: false, status: 'COUNTING' }, false))
    assert.deepEqual(COUNT_CAN.approve, ['REVIEW'])
    assert.notInclude(COUNT_CAN.cancel, 'APPROVED')
    assert.include(COUNT_CAN.addLine, 'COUNTING')
  })
})
