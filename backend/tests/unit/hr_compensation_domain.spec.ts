import { test } from '@japa/runner'
import {
  componentIssues,
  lineIssues,
  percentOf,
  percentText,
  percentUnits,
} from '#modules/hr/domain/compensation'

const comps = new Map([
  ['fixed', { calculation: 'FIXED' as const, status: 'ACTIVE' }],
  ['pct', { calculation: 'PERCENT_OF_BASE' as const, status: 'ACTIVE' }],
  ['var', { calculation: 'VARIABLE' as const, status: 'ACTIVE' }],
  ['old', { calculation: 'FIXED' as const, status: 'INACTIVE' }],
])
const codes = (lines: unknown) => lineIssues(lines, comps).map((i) => `${i.path}:${i.code}`)

test.group('RH | domínio da compensação (7.5)', () => {
  test('percentagens exactas com 4 casas e valor sobre o salário base ao cêntimo', ({ assert }) => {
    assert.equal(percentUnits('12.5'), 125000n)
    assert.equal(percentText(125000n), '12.5000')
    assert.isNull(percentUnits('100.0001'))
    assert.isNull(percentUnits('1.23456'))
    assert.isNull(percentUnits('-1'))
    assert.equal(percentOf('200000.00', '10'), '20000.00')
    assert.equal(percentOf('123456.78', '7.5'), '9259.26') // 9259,2585 → meio para cima
    assert.equal(percentOf('0.10', '33.3333'), '0.03')
    assert.equal(percentOf('99999.99', '100'), '99999.99')
  })

  test('linhas: componente existente e activo, sem repetidos, valor conforme o cálculo, variáveis fora', ({
    assert,
  }) => {
    assert.deepEqual(codes([]), ['lines:REQUIRED'])
    assert.deepEqual(codes([{ componentId: 'fixed', action: 'SET', amount: '1000' }]), [])
    assert.deepEqual(codes([{ componentId: 'pct', action: 'SET', percent: '10' }]), [])
    assert.include(
      codes([{ componentId: 'fixed', action: 'SET', percent: '10' }]),
      'lines.0.amount:INVALID_AMOUNT'
    )
    assert.include(
      codes([{ componentId: 'pct', action: 'SET', amount: '10' }]),
      'lines.0.percent:INVALID_PERCENT'
    )
    assert.include(
      codes([{ componentId: 'var', action: 'SET', amount: '10' }]),
      'lines.0.componentId:VARIABLE_COMPONENT'
    )
    assert.include(
      codes([{ componentId: 'old', action: 'SET', amount: '10' }]),
      'lines.0.componentId:INACTIVE'
    )
    // Remover um inactivo é permitido (deixa de pagar).
    assert.deepEqual(codes([{ componentId: 'old', action: 'REMOVE' }]), [])
    assert.include(codes([{ componentId: 'x', action: 'SET' }]), 'lines.0.componentId:NOT_FOUND')
    assert.include(
      codes([
        { componentId: 'fixed', action: 'SET', amount: '1' },
        { componentId: 'fixed', action: 'REMOVE' },
      ]),
      'lines.1.componentId:DUPLICATE'
    )
    assert.include(codes([{ componentId: 'fixed', action: 'KEEP' }]), 'lines.0.action:INVALID')
  })

  test('natureza e categoria coerentes', ({ assert }) => {
    assert.deepEqual(componentIssues({ kind: 'EARNING', category: 'ALLOWANCE' }), [])
    assert.deepEqual(componentIssues({ kind: 'DEDUCTION', category: 'DEDUCTION' }), [])
    assert.equal(
      componentIssues({ kind: 'EARNING', category: 'DEDUCTION' })[0].code,
      'INCONSISTENT'
    )
    assert.equal(componentIssues({ kind: 'DEDUCTION', category: 'BONUS' })[0].code, 'INCONSISTENT')
  })
})
