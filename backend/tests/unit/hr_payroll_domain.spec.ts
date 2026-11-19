import { test } from '@japa/runner'
import {
  applyRate,
  bracketIssues,
  calculate,
  difference,
  irtFor,
  overlapDays,
  prorate,
  rateUnits,
  type Rules,
  runCase,
  sampleIssues,
  simulate,
  testCaseIssues,
} from '#modules/hr/domain/payroll'

/**
 * Valores de TESTE (não são a tabela oficial): servem para verificar o mecanismo. As regras reais são configuradas
 * pela empresa com a fonte legal.
 */
const brackets = [
  { lower: '0.00', upper: '100000.00', fixedAmount: '0.00', rate: '0', excessOver: '0.00' },
  {
    lower: '100000.01',
    upper: '200000.00',
    fixedAmount: '0.00',
    rate: '10',
    excessOver: '100000.00',
  },
  { lower: '200000.01', upper: null, fixedAmount: '10000.00', rate: '20', excessOver: '200000.00' },
]
const rules: Rules = {
  id: 'r',
  inssEmployeeRate: '3',
  inssEmployerRate: '8',
  baseIrtSubject: true,
  baseInssSubject: true,
  irtBaseDeductsInss: true,
  dayBasis: 'FIXED_30',
  brackets,
}
const money = (c: bigint) => {
  const s = c.toString().padStart(3, '0')
  return `${s.slice(0, -2)}.${s.slice(-2)}`
}

test.group('RH | motor de processamento (domínio)', () => {
  test('taxas, arredondamento ao cêntimo e proporção', ({ assert }) => {
    assert.equal(rateUnits('3'), 30000n)
    assert.equal(rateUnits('6.5'), 65000n)
    assert.equal(rateUnits('0.0001'), 1n)
    assert.equal(applyRate(20000000n, '3'), 600000n) // 3% de 200 000,00
    assert.equal(applyRate(1n, '50'), 1n) // 0,005 → 0,01 (meio para cima)
    assert.equal(applyRate(333n, '3'), 10n) // 9,99 cêntimos → 10
    assert.equal(prorate(20000000n, 15n, 30n), 10000000n)
    assert.equal(prorate(10000n, 1n, 3n), 3333n)
    assert.equal(overlapDays('2026-01-15', '2026-02-10', '2026-02-01', '2026-02-28'), 10)
    assert.equal(overlapDays('2026-03-01', '2026-03-05', '2026-02-01', '2026-02-28'), 0)
  })

  test('tabela progressiva: parcela fixa + taxa sobre o excesso, por escalão', ({ assert }) => {
    assert.equal(irtFor(0n, brackets), 0n)
    assert.equal(irtFor(10000000n, brackets), 0n)
    assert.equal(irtFor(15000000n, brackets), 500000n) // (150 000 − 100 000) × 10%
    assert.equal(irtFor(30000000n, brackets), 3000000n) // 10 000 + 100 000 × 20%
    assert.isNull(irtFor(100n, [{ ...brackets[1] }]))
  })

  test('validação dos escalões', ({ assert }) => {
    assert.deepEqual(bracketIssues(brackets), [])
    const codes = (b: unknown) => bracketIssues(b).map((i) => i.code)
    assert.include(codes([]), 'REQUIRED')
    assert.include(codes([{ ...brackets[1] }]), 'GAP') // não começa em 0
    assert.include(codes([brackets[0], { ...brackets[2], lower: '100000.05' }]), 'GAP')
    assert.include(codes([brackets[0]]), 'OPEN_LAST')
    assert.include(codes([{ ...brackets[0], upper: null }, brackets[2]]), 'GAP')
    assert.include(codes([{ ...brackets[2], lower: '0.00', rate: '120' }]), 'INVALID_PERCENT')
  })

  test('recibo completo: base, componentes com incidência e isenção, INSS, IRT, empréstimo, patronal', ({
    assert,
  }) => {
    const r = calculate({
      period: '2026-11-01',
      daysInMonth: 30,
      base: { amount: '200000.00', payableDays: 30 },
      items: [
        {
          componentId: 'a',
          code: 'SUBALIM',
          name: 'Subsídio de alimentação',
          kind: 'EARNING',
          amount: '40000.00',
          recurring: true,
          incidence: { irtSubject: true, irtExemptAmount: '30000.00', inssSubject: false },
        },
        {
          componentId: 'b',
          code: 'SINDICATO',
          name: 'Quota sindical',
          kind: 'DEDUCTION',
          amount: '1000.00',
          recurring: true,
          incidence: null,
        },
      ],
      unpaidAbsences: [],
      loans: [{ installmentId: 'i', loanCode: 'EMP-1', amount: '5000.00' }],
      rules,
    })
    assert.deepEqual(r.errors, [])
    const t = r.totals
    assert.equal(money(t.gross), '240000.00')
    assert.equal(money(t.inssBase), '200000.00') // o subsídio não está sujeito a INSS
    assert.equal(money(t.inssEmployee), '6000.00')
    // IRT: 200 000 + (40 000 − 30 000 isento) − 6 000 de INSS = 204 000 → 10 000 + 4 000 × 20%
    assert.equal(money(t.irtBase), '204000.00')
    assert.equal(money(t.irt), '10800.00')
    assert.equal(money(t.deductions), '1000.00')
    assert.equal(money(t.loans), '5000.00')
    assert.equal(money(t.net), '217200.00')
    assert.equal(money(t.inssEmployer), '16000.00')
    assert.equal(money(t.employerCost), '256000.00')
    assert.deepEqual(
      r.lines.map((l) => l.source),
      ['BASE', 'COMPONENT', 'COMPONENT', 'INSS', 'IRT', 'LOAN', 'INSS_EMPLOYER']
    )
  })

  test('mês incompleto e faltas não remuneradas; regras de base do IRT', ({ assert }) => {
    const r = calculate({
      period: '2026-02-01',
      daysInMonth: 28,
      base: { amount: '280000.00', payableDays: 14 },
      items: [
        {
          componentId: 'a',
          code: 'SUB',
          name: 'Subsídio',
          kind: 'EARNING',
          amount: '28000.00',
          recurring: true,
          incidence: { irtSubject: false, irtExemptAmount: null, inssSubject: false },
        },
      ],
      unpaidAbsences: [{ code: 'FALTA', days: '2.00' }],
      loans: [],
      rules: { ...rules, irtBaseDeductsInss: false },
    })
    const base = r.lines.find((l) => l.source === 'BASE')!
    const absence = r.lines.find((l) => l.source === 'ABSENCE')!
    const sub = r.lines.find((l) => l.code === 'SUB')!
    assert.equal(money(base.amount), '140000.00') // 14/28
    assert.equal(money(sub.amount), '14000.00') // recorrente na mesma proporção
    assert.equal(absence.amount, -1866667n) // 280 000 ÷ 30 × 2 (base fixa de 30 dias)
    assert.equal(money(r.totals.irtBase), '121333.33') // sem dedução do INSS
  })

  test('erros por colaborador em vez de valores inventados', ({ assert }) => {
    const r = calculate({
      period: '2026-11-01',
      daysInMonth: 30,
      base: { amount: '10000.00', payableDays: 30 },
      items: [
        {
          componentId: 'x',
          code: 'HEXTRA',
          name: 'Horas extra',
          kind: 'EARNING',
          amount: '500.00',
          recurring: false,
          incidence: null,
        },
      ],
      unpaidAbsences: [],
      loans: [{ installmentId: 'i', loanCode: 'EMP-9', amount: '20000.00' }],
      rules,
    })
    assert.includeMembers(
      r.errors.map((e) => e.code),
      ['MISSING_INCIDENCE', 'NEGATIVE_NET']
    )
  })

  test('retroactivo: diferença linha a linha contra o já processado, sem empréstimos', ({
    assert,
  }) => {
    const before = calculate({
      period: '2026-10-01',
      daysInMonth: 31,
      base: { amount: '200000.00', payableDays: 31 },
      items: [],
      unpaidAbsences: [],
      loans: [{ installmentId: 'i', loanCode: 'EMP-1', amount: '5000.00' }],
      rules,
    })
    const after = calculate({
      period: '2026-10-01',
      daysInMonth: 31,
      base: { amount: '220000.00', payableDays: 31 },
      items: [],
      unpaidAbsences: [],
      loans: [],
      rules,
    })
    const d = difference(after.lines, before.lines)
    const by = (code: string) => d.find((l) => l.code === code)?.amount
    assert.equal(by('BASE'), 2000000n)
    assert.equal(by('INSS'), 60000n) // 3% de 20 000
    assert.equal(by('INSS-PATRONAL'), 160000n)
    // IRT recalculado sobre 213 400 contra 194 000 já retido
    assert.equal(by('IRT'), irtFor(21340000n, brackets)! - irtFor(19400000n, brackets)!)
    assert.isUndefined(d.find((l) => l.source === 'LOAN'))
    assert.isTrue(d.every((l) => l.name.startsWith('Diferença: ')))
    assert.deepEqual(difference(before.lines, before.lines), [])
  })

  test('simulador e casos de teste: comparação ao cêntimo, só nos campos indicados', ({
    assert,
  }) => {
    const sample = {
      baseSalary: '200000.00',
      allowancesSubject: '10000.00',
      allowancesIrtOnly: '30000.00',
      allowancesExempt: '5000.00',
    }
    const t = simulate(rules, sample).totals
    assert.equal(money(t.gross), '245000.00')
    assert.equal(money(t.inssBase), '210000.00')
    assert.equal(money(t.irtBase), '233700.00')
    const base = {
      ...sample,
      description: 'Caso',
      source: 'Fonte de teste',
      expectedInssEmployee: '6300.00',
      expectedIrt: '16740.00',
      expectedInssEmployer: null,
      expectedNet: null,
    }
    assert.isTrue(runCase(rules, base).pass)
    const wrong = runCase(rules, { ...base, expectedNet: '1.00', expectedIrt: '16740.01' })
    assert.isFalse(wrong.pass)
    assert.deepEqual(
      wrong.mismatches.map((x) => x.field),
      ['irt', 'net']
    )
  })

  test('validação de exemplos e casos', ({ assert }) => {
    assert.deepEqual(
      sampleIssues({ baseSalary: '1 000' }).issues.map((i) => i.code),
      ['INVALID_AMOUNT']
    )
    assert.equal(sampleIssues({ baseSalary: '1000,5' }).value?.baseSalary, '1000.50')
    assert.equal(sampleIssues({ baseSalary: '1000' }).value?.allowancesExempt, '0.00')
    const r = testCaseIssues([
      {
        description: 'Ok',
        source: 'Fonte boa',
        baseSalary: '1',
        expectedInssEmployee: '0',
        expectedIrt: '0',
      },
      { description: 'x', baseSalary: '1' },
    ])
    assert.lengthOf(r.value, 1)
    assert.includeMembers(
      r.issues.map((i) => `${i.path}:${i.code}`),
      [
        'testCases.1.description:LENGTH',
        'testCases.1.source:LENGTH',
        'testCases.1.expectedInssEmployee:REQUIRED',
        'testCases.1.expectedIrt:REQUIRED',
      ]
    )
    assert.equal(testCaseIssues('x').issues[0].code, 'INVALID')
  })
})
