import { test } from '@japa/runner'
import {
  CAN,
  checkedIssue,
  lineIssues,
  normalizeSerials,
  ORIGINS,
  statusFrom,
  type LineFacts,
} from '#modules/inventory/domain/documents'

const U = 1_000_000n
const facts = (over: Partial<LineFacts> = {}): LineFacts => ({
  docType: 'RECEIPT',
  trackLots: false,
  trackSerials: false,
  trackExpiry: false,
  lotCode: null,
  serials: [],
  expiryDate: null,
  baseQuantity: 2n * U,
  unitCost: null,
  ...over,
})
const codes = (i: { code: string }[]) => i.map((x) => x.code)

test.group('Inventário | domínio dos documentos (8.4)', () => {
  test('rastreabilidade e custo por linha; séries normalizadas', ({ assert }) => {
    assert.deepEqual(lineIssues(facts(), 'l'), [])
    assert.include(codes(lineIssues(facts({ trackLots: true }), 'l')), 'REQUIRED')
    assert.include(codes(lineIssues(facts({ lotCode: 'L1' }), 'l')), 'NOT_TRACKED')
    assert.include(codes(lineIssues(facts({ trackExpiry: true }), 'l')), 'REQUIRED')
    assert.deepEqual(lineIssues(facts({ docType: 'ISSUE', trackExpiry: true }), 'l'), [])
    assert.include(
      codes(lineIssues(facts({ trackSerials: true, serials: ['A'] }), 'l')),
      'SERIAL_COUNT'
    )
    assert.deepEqual(lineIssues(facts({ trackSerials: true, serials: ['A', 'B'] }), 'l'), [])
    assert.include(
      codes(lineIssues(facts({ trackSerials: true, baseQuantity: U + 1n, serials: ['A'] }), 'l')),
      'SERIAL_DECIMALS'
    )
    assert.include(codes(lineIssues(facts({ docType: 'ISSUE', unitCost: 5n }), 'l')), 'NOT_ALLOWED')
    assert.deepEqual(normalizeSerials([' a1 ', 'B2']), ['a1', 'B2'])
    assert.isNull(normalizeSerials(['A1', 'a1']))
    assert.isNull(normalizeSerials(['']))
    assert.deepEqual(normalizeSerials(undefined), [])
    assert.include(ORIGINS.RECEIPT, 'PURCHASE')
    assert.notInclude(ORIGINS.RECEIPT, 'SALE')
    assert.include(ORIGINS.ISSUE, 'LOSS')
  })

  test('estado, conferência e acções por estado', ({ assert }) => {
    assert.equal(statusFrom([{ quantity: 5n, confirmed: 0n }], false), 'DRAFT')
    assert.equal(statusFrom([{ quantity: 5n, confirmed: 2n }], true), 'PARTIAL')
    assert.equal(statusFrom([{ quantity: 5n, confirmed: 0n }], true), 'PARTIAL')
    assert.equal(
      statusFrom(
        [
          { quantity: 5n, confirmed: 5n },
          { quantity: 1n, confirmed: 1n },
        ],
        true
      ),
      'COMPLETED'
    )
    assert.isNull(checkedIssue(3n, 5n, false))
    assert.isNotNull(checkedIssue(6n, 5n, false))
    assert.isNotNull(checkedIssue(-1n, 5n, false))
    assert.isNotNull(checkedIssue(2n, 5n, true))
    assert.isNull(checkedIssue(5n, 5n, true))
    assert.isNull(checkedIssue(0n, 5n, true))
    assert.deepEqual([...CAN.edit], ['DRAFT'])
    assert.include(CAN.check, 'PARTIAL')
    assert.notInclude(CAN.cancel, 'PARTIAL')
    assert.deepEqual([...CAN.confirm], ['CHECKED'])
  })
})
