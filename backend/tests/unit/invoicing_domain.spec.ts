import { test } from '@japa/runner'
import { lineAmounts } from '#modules/orders/index'
import { orderLineValues } from '#modules/invoicing/application/order_line_values'
import {
  addDays,
  billableQuantity,
  creditLineValues,
  effectiveContractStatus,
  fullyCredited,
  manualLineValues,
  noticeDeadline,
  normalizeContract,
  type ContractInput,
  type Issue,
} from '#modules/invoicing/domain/invoicing'

const source = {
  id: 'ol1',
  variantId: 'v1',
  description: 'Camisola',
  unitPrice: '33.3333',
  discountRate: '0.1',
  taxRate: '14',
  taxInclusive: false,
}

test.group('facturação | linhas a partir da encomenda', () => {
  test('facturar a quantidade toda dá exactamente os valores da encomenda', ({ assert }) => {
    const mine = orderLineValues(source, '3', 'HALF_UP')
    const theirs = lineAmounts(
      {
        quantity: '3',
        unitPrice: source.unitPrice,
        discountRate: source.discountRate,
        taxRate: source.taxRate,
        taxInclusive: false,
      },
      'HALF_UP'
    )
    assert.isNotNull(mine)
    assert.deepInclude(mine, {
      netAmount: theirs?.net,
      taxAmount: theirs?.tax,
      total: theirs?.total,
      salesOrderLineId: 'ol1',
      taxCode: 'IVA-14',
      exemptionReason: null,
    })
  })

  test('o desconto fica como valor e uma taxa zero traz o motivo da isenção', ({ assert }) => {
    const line = orderLineValues({ ...source, unitPrice: '100', taxRate: '0' }, '2', 'HALF_UP')
    assert.deepInclude(line, {
      discountAmount: '20.0000',
      netAmount: '180.0000',
      taxAmount: '0.0000',
      taxCode: 'ISENTO',
      exemptionReason: 'Sem imposto aplicável',
    })
  })

  test('a quantidade facturável segue a expedição nos bens com stock e a encomenda nos serviços', ({
    assert,
  }) => {
    const base = { ordered: 10_000_000n, shipped: 4_000_000n, billed: 1_000_000n }
    assert.equal(billableQuantity({ ...base, stockTracked: true }), 3_000_000n)
    assert.equal(billableQuantity({ ...base, stockTracked: false }), 9_000_000n)
    assert.equal(billableQuantity({ ...base, billed: 10_000_000n, stockTracked: false }), 0n)
    assert.equal(
      billableQuantity({ ...base, shipped: 99_000_000n, stockTracked: true }),
      9_000_000n
    )
    assert.equal(billableQuantity({ ...base, billed: 5_000_000n, stockTracked: true }), 0n)
  })
})

test.group('facturação | linhas livres', () => {
  test('calcula líquido, imposto e total com aritmética exacta', ({ assert }) => {
    const issues: Issue[] = []
    const line = manualLineValues(
      { description: 'Consultoria', quantity: '2', unitPrice: '50', taxRate: '14' },
      '',
      'HALF_UP',
      issues
    )
    assert.isEmpty(issues)
    assert.deepInclude(line, { netAmount: '100.0000', taxAmount: '14.0000', total: '114.0000' })
  })

  test('uma taxa zero exige o motivo; o desconto não passa do valor da linha', ({ assert }) => {
    const issues: Issue[] = []
    assert.isNull(
      manualLineValues(
        { description: 'x', quantity: '1', unitPrice: '10', taxRate: '0' },
        'lines[0].',
        'HALF_UP',
        issues
      )
    )
    assert.equal(issues[0]?.code, 'EXEMPTION_REQUIRED')
    assert.equal(issues[0]?.path, 'lines[0].exemptionReason')
    const over: Issue[] = []
    assert.isNull(
      manualLineValues(
        { description: 'x', quantity: '1', unitPrice: '10', discountAmount: '11', taxRate: '14' },
        '',
        'HALF_UP',
        over
      )
    )
    assert.equal(over[0]?.code, 'DISCOUNT_EXCEEDS')
  })

  test('recusa quantidades, preços e taxas inválidos', ({ assert }) => {
    const issues: Issue[] = []
    manualLineValues(
      { description: '', quantity: '0', unitPrice: '-1', taxRate: '1e2' },
      '',
      'HALF_UP',
      issues
    )
    assert.sameMembers(
      issues.map((i) => i.code),
      ['INVALID_DESCRIPTION', 'INVALID_QUANTITY', 'INVALID_PRICE', 'INVALID_TAX_RATE']
    )
  })
})

const line = { quantity: 3_000_000n, net: 1_000_000n, tax: 140_000n }
const none = { quantity: 0n, net: 0n, tax: 0n }

test.group('facturação | notas de crédito', () => {
  test('o crédito é proporcional à quantidade e o que resta dá exactamente o resto', ({
    assert,
  }) => {
    const issues: Issue[] = []
    const first = creditLineValues(line, none, { quantity: '1' }, 'HALF_UP', '', issues)
    assert.deepEqual(first, { quantity: '1', amount: '33.3333', taxAmount: '4.6667' })
    const after = { quantity: 1_000_000n, net: 333_333n, tax: 46_667n }
    const rest = creditLineValues(line, after, { quantity: '2' }, 'HALF_UP', '', issues)
    assert.deepEqual(rest, { quantity: '2', amount: '66.6667', taxAmount: '9.3333' })
    assert.isEmpty(issues)
  })

  test('nunca credita mais do que a quantidade ou o valor que faltam', ({ assert }) => {
    const issues: Issue[] = []
    const done = { quantity: 2_000_000n, net: 666_667n, tax: 93_333n }
    assert.isNull(creditLineValues(line, done, { quantity: '2' }, 'HALF_UP', 'lines[0].', issues))
    assert.equal(issues[0]?.code, 'EXCEEDS_CREDITABLE')
    assert.equal(issues[0]?.path, 'lines[0].quantity')
    const byAmount: Issue[] = []
    assert.isNull(
      creditLineValues(line, done, { quantity: '1', amount: '40' }, 'HALF_UP', '', byAmount)
    )
    assert.equal(byAmount[0]?.code, 'EXCEEDS_CREDITABLE')
  })

  test('um valor explícito leva o imposto proporcional', ({ assert }) => {
    const issues: Issue[] = []
    const value = creditLineValues(
      line,
      none,
      { quantity: '1', amount: '50' },
      'HALF_UP',
      '',
      issues
    )
    assert.deepEqual(value, { quantity: '1', amount: '50.0000', taxAmount: '7.0000' })
  })

  test('a factura só fica creditada quando todas as linhas estão totalmente creditadas', ({
    assert,
  }) => {
    assert.isFalse(fullyCredited([]))
    assert.isFalse(fullyCredited([{ line, credited: { ...line, net: 999_999n } }]))
    assert.isTrue(fullyCredited([{ line, credited: line }]))
  })
})

test.group('facturação | contratos', () => {
  const input: ContractInput = {
    organizationId: 'o1',
    partyId: 'p1',
    title: 'Manutenção',
    startDate: '2026-01-01',
    endDate: '2026-12-31',
    noticeDays: 30,
  }

  test('valida e normaliza; o fim anterior ao início e a renovação sem fim são recusados', ({
    assert,
  }) => {
    const issues: Issue[] = []
    const values = normalizeContract(input, null, 'AOA', issues)
    assert.isEmpty(issues)
    assert.deepInclude(values, {
      type: 'SERVICE',
      currency: 'AOA',
      renewalMode: 'NONE',
      amount: null,
    })
    const bad: Issue[] = []
    normalizeContract({ ...input, endDate: '2025-12-31', renewalMode: 'AUTO' }, null, 'AOA', bad)
    assert.include(
      bad.map((i) => i.code),
      'END_BEFORE_START'
    )
    const open: Issue[] = []
    normalizeContract({ ...input, endDate: null, renewalMode: 'MANUAL' }, null, 'AOA', open)
    assert.equal(open[0]?.code, 'END_REQUIRED')
  })

  test('um contrato activo cujo fim passou está expirado; o aviso é fim menos os dias', ({
    assert,
  }) => {
    assert.equal(effectiveContractStatus('ACTIVE', '2026-01-31', '2026-02-01'), 'EXPIRED')
    assert.equal(effectiveContractStatus('ACTIVE', '2026-01-31', '2026-01-31'), 'ACTIVE')
    assert.equal(effectiveContractStatus('TERMINATED', '2020-01-01', '2026-01-31'), 'TERMINATED')
    assert.equal(effectiveContractStatus('ACTIVE', null, '2099-01-01'), 'ACTIVE')
    assert.equal(noticeDeadline('2026-12-31', 30), '2026-12-01')
    assert.isNull(noticeDeadline(null, 30))
    assert.equal(addDays('2026-02-27', 2), '2026-03-01')
  })
})
