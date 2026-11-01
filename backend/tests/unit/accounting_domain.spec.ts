import { test } from '@japa/runner'
import {
  PGC_CLASSES,
  classOf,
  isAccountCode,
  isParentCode,
  natureBalance,
  periodsOf,
  reverseLines,
  runningBalance,
  validateLines,
} from '#modules/accounting/domain/accounting'

const line = (debit: string, credit: string, accountId = 'a') => ({ accountId, debit, credit })

test.group('contabilidade: plano de contas', () => {
  test('códigos, classe e hierarquia por prefixo', ({ assert }) => {
    for (const ok of ['1', '31', '31.1', '31.1.2', '622.13']) assert.isTrue(isAccountCode(ok), ok)
    for (const bad of ['0', '01', '3A', '31.', '.1', '31..1', '', 'x'.repeat(21)])
      assert.isFalse(isAccountCode(bad), bad)
    assert.equal(classOf('61.1'), 6)
    assert.isTrue(isParentCode('3', '31.1'))
    assert.isTrue(isParentCode('31', '31.1'))
    assert.isFalse(isParentCode('31', '31'))
    assert.isFalse(isParentCode('31', '41.1'))
    assert.deepEqual(
      PGC_CLASSES.map((c) => c.code),
      ['1', '2', '3', '4', '5', '6', '7', '8']
    )
  })
})

test.group('contabilidade: exercícios', () => {
  test('períodos mensais pelo calendário, também em exercícios irregulares', ({ assert }) => {
    const year = periodsOf('2031-01-01', '2031-12-31')
    assert.property(year, 'periods')
    if ('periods' in year) {
      assert.lengthOf(year.periods, 12)
      assert.deepEqual(year.periods[1], { number: 2, startsOn: '2031-02-01', endsOn: '2031-02-28' })
      assert.deepEqual(year.periods[11], {
        number: 12,
        startsOn: '2031-12-01',
        endsOn: '2031-12-31',
      })
    }
    const leap = periodsOf('2032-02-01', '2032-02-29')
    if ('periods' in leap)
      assert.deepEqual(leap.periods, [{ number: 1, startsOn: '2032-02-01', endsOn: '2032-02-29' }])
    const shifted = periodsOf('2031-07-15', '2032-07-14')
    if ('periods' in shifted) {
      assert.lengthOf(shifted.periods, 13)
      assert.deepEqual(shifted.periods[0], {
        number: 1,
        startsOn: '2031-07-15',
        endsOn: '2031-07-31',
      })
      assert.equal(shifted.periods[12]?.endsOn, '2032-07-14')
    }
    assert.property(periodsOf('2031-12-31', '2031-01-01'), 'issue')
    assert.property(periodsOf('2031-02-30', '2031-12-31'), 'issue')
    assert.property(periodsOf('2031-01-01', '2033-06-30'), 'issue')
  })
})

test.group('contabilidade: linhas e saldos', () => {
  test('partidas dobradas, exactas e com um lado por linha', ({ assert }) => {
    const ok = validateLines([line('100.1', ''), line('', '60'), line('', '40.1')], true)
    assert.property(ok, 'value')
    if ('value' in ok)
      assert.deepEqual([ok.value.totalDebit, ok.value.totalCredit], ['100.1000', '100.1000'])
    const unbalanced = validateLines([line('100', ''), line('', '99.9999')], true)
    assert.property(unbalanced, 'issues')
    if ('issues' in unbalanced) assert.equal(unbalanced.issues[0]?.code, 'UNBALANCED')
    // Num rascunho o desequilíbrio é permitido.
    assert.property(validateLines([line('100', '')], false), 'value')
    for (const [bad, expected] of [
      [[line('1', '1'), line('', '1')], 'ONE_SIDE'],
      [[line('0', '0'), line('', '1')], 'ONE_SIDE'],
      [[line('-1', ''), line('', '1')], 'INVALID_AMOUNT'],
      [[line('1.00001', ''), line('', '1.00001')], 'INVALID_AMOUNT'],
      [[line('1', '')], 'TOO_FEW'],
      [[{ debit: '1', credit: '' }, line('', '1')], 'REQUIRED'],
    ] as const) {
      const result = validateLines(bad, true)
      assert.property(result, 'issues')
      if ('issues' in result) assert.equal(result.issues[0]?.code, expected)
    }
    assert.property(validateLines('x', true), 'issues')
  })

  test('o inverso troca os lados e os saldos acumulam sem perder precisão', ({ assert }) => {
    const reversed = reverseLines([
      {
        accountId: 'a',
        debit: '10.0000',
        credit: '0.0000',
        description: null,
        costCenterId: 'cc',
        partyId: null,
      },
    ])
    assert.deepEqual(
      [reversed[0]?.debit, reversed[0]?.credit, reversed[0]?.costCenterId],
      ['0.0000', '10.0000', 'cc']
    )
    assert.deepEqual(
      runningBalance('-5.0000', [
        { debit: '0.1000', credit: '0.0000' },
        { debit: '0.0000', credit: '0.2000' },
        { debit: '10.0000', credit: '0.0000' },
      ]),
      ['-4.9000', '-5.1000', '4.9000']
    )
    assert.equal(natureBalance('DEBIT', '100.0000', '30.0000'), '70.0000')
    assert.equal(natureBalance('CREDIT', '100.0000', '30.0000'), '-70.0000')
  })
})
