import { test } from '@japa/runner'
import {
  fulfilmentStatus,
  lineAmounts,
  money,
  nextStep,
  normalizeLines,
  parseScaled,
  requiredLevels,
  toFunctional,
} from '#modules/procurement/domain/requisitions'

const q = (v: string) => parseScaled(v, 6)!
const c = (v: string) => parseScaled(v, 2)!

test.group('Compras | domínio das requisições (9.2)', () => {
  test('valores das linhas e conversão para moeda funcional, ao cêntimo', ({ assert }) => {
    const a = lineAmounts(q('10'), q('1000'), parseScaled('14', 3)!)
    assert.deepEqual(
      [money(a.net), money(a.tax), money(a.total)],
      ['10000.00', '1400.00', '11400.00']
    )
    // 3 × 0,333333 = 0,999999 → 1,00; imposto de 6,5% sobre 1,00 = 0,065 → 0,07 (meio para cima).
    const b = lineAmounts(q('3'), q('0.333333'), parseScaled('6.5', 3)!)
    assert.deepEqual([money(b.net), money(b.tax)], ['1.00', '0.07'])
    assert.equal(money(toFunctional(c('600000.00'), parseScaled('900.5', 10)!)), '540300000.00')
    assert.isNull(parseScaled('1.0000001', 6))
    assert.isNull(parseScaled('-1', 6))
  })

  test('etapas exigidas pelo valor e quem pode decidir a seguinte', ({ assert }) => {
    const levels = [
      {
        id: 'b',
        code: 'DIR',
        name: 'Direcção',
        sequence: 2,
        approverRoleId: 'r-dir',
        minCents: c('500000'),
      },
      { id: 'a', code: 'CHEFIA', name: 'Chefia', sequence: 1, approverRoleId: null, minCents: 0n },
    ]
    assert.deepEqual(
      requiredLevels(levels, c('13900.50')).map((l) => l.code),
      ['CHEFIA']
    )
    const both = requiredLevels(levels, c('500000.00'))
    assert.deepEqual(
      both.map((l) => l.code),
      ['CHEFIA', 'DIR']
    )
    assert.deepEqual(
      requiredLevels([], c('1')).map((l) => l.code),
      ['BASE']
    )
    const me = (membershipId: string, roles: string[] = [], isRequester = false) => ({
      membershipId,
      isRequester,
      roleIds: new Set(roles),
    })
    assert.deepInclude(nextStep(both, [], me('req', [], true)), {
      allowed: false,
      reason: 'SELF_APPROVAL',
    })
    assert.deepInclude(nextStep(both, [], me('chefe')), { allowed: true })
    const after = [{ sequence: 1, membershipId: 'chefe' }]
    assert.deepInclude(nextStep(both, after, me('chefe', ['r-dir'])), {
      allowed: false,
      reason: 'SAME_APPROVER',
    })
    assert.deepInclude(nextStep(both, after, me('outro')), {
      allowed: false,
      reason: 'ROLE_REQUIRED',
    })
    const ok = nextStep(both, after, me('dir', ['r-dir']))
    assert.isTrue(ok.allowed)
    assert.equal(ok.step!.code, 'DIR')
    assert.deepInclude(nextStep(both, [...after, { sequence: 2, membershipId: 'dir' }], me('x')), {
      step: null,
      reason: 'DONE',
    })
  })

  test('atendimento parcial e validação das linhas', ({ assert }) => {
    const L = (quantity: string, ordered: string, closed = '0') => ({
      quantity: q(quantity),
      ordered: q(ordered),
      closed: q(closed),
    })
    assert.equal(fulfilmentStatus('APPROVED', [L('10', '0'), L('1', '0')]), 'APPROVED')
    assert.equal(fulfilmentStatus('APPROVED', [L('10', '6'), L('1', '0')]), 'PARTIALLY_ORDERED')
    assert.equal(fulfilmentStatus('PARTIALLY_ORDERED', [L('10', '10'), L('1', '1')]), 'ORDERED')
    assert.equal(fulfilmentStatus('ORDERED', [L('10', '8'), L('1', '1')]), 'PARTIALLY_ORDERED')
    assert.equal(fulfilmentStatus('CLOSED', [L('10', '8', '2')]), 'CLOSED')
    const { issues } = normalizeLines([
      { quantity: '0', description: 'Papel' },
      { quantity: '1', estimatedUnitPrice: '-5', description: 'ok' },
      { quantity: '2', taxRate: '120' },
      { quantity: 1.5, description: 'Toner', neededBy: '2026-02-30' },
    ])
    assert.deepEqual(
      issues.map((i) => `${i.path}:${i.code}`),
      [
        'lines.0.quantity:INVALID',
        'lines.1.estimatedUnitPrice:INVALID',
        'lines.1.description:REQUIRED',
        'lines.2.taxRate:INVALID',
        'lines.2.description:REQUIRED',
        'lines.3.neededBy:INVALID',
      ]
    )
    assert.deepInclude(normalizeLines([]).issues[0], { code: 'REQUIRED' })
  })
})
