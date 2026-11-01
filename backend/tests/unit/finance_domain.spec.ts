import { test } from '@japa/runner'
import {
  addDays,
  balanceOf,
  creditHeadroom,
  exceedsCredit,
  matchInvoice,
  normalizeAccount,
  normalizePayment,
  sumInvoiceLines,
  supplierInvoiceLine,
  viewOf,
  type Issue,
} from '#modules/finance/domain/finance'

const issuesOf = (run: (issues: Issue[]) => unknown) => {
  const issues: Issue[] = []
  run(issues)
  return issues.map((i) => `${i.path}:${i.code}`)
}

test.group('finanças | saldo e vista das obrigações', () => {
  test('o saldo deriva do original, dos créditos e dos pagamentos e nunca é negativo', ({
    assert,
  }) => {
    assert.equal(balanceOf({ original: '114.0000', credits: '0.0000', paid: '40.0000' }), '74.0000')
    assert.equal(balanceOf({ original: '114.0000', credits: '57.0000', paid: '57.0000' }), '0.0000')
    assert.equal(balanceOf({ original: '10.0000', credits: '0', paid: '12.0000' }), '0.0000')
    assert.equal(balanceOf({ original: '0.0001', credits: '0', paid: '0' }), '0.0001')
  })

  test('a vista distingue aberto, parcial, vencido, liquidado e cancelado', ({ assert }) => {
    const none = { original: '100.0000', credits: '0.0000', paid: '0.0000' }
    const some = { original: '100.0000', credits: '0.0000', paid: '30.0000' }
    assert.equal(viewOf('OPEN', none, '2026-12-01', '2026-11-01'), 'OPEN')
    assert.equal(viewOf('OPEN', some, '2026-12-01', '2026-11-01'), 'PARTIAL')
    assert.equal(viewOf('OPEN', some, '2026-10-31', '2026-11-01'), 'OVERDUE')
    assert.equal(viewOf('OPEN', none, '2026-11-01', '2026-11-01'), 'OPEN')
    assert.equal(viewOf('CLOSED', none, '2020-01-01', '2026-11-01'), 'CLOSED')
    assert.equal(viewOf('CANCELLED', none, '2020-01-01', '2026-11-01'), 'CANCELLED')
  })

  test('somar dias respeita o calendário', ({ assert }) => {
    assert.equal(addDays('2026-01-31', 30), '2026-03-02')
    assert.equal(addDays('2026-12-31', 1), '2027-01-01')
    assert.equal(addDays('2026-03-01', 0), '2026-03-01')
  })
})

test.group('finanças | pagamentos', () => {
  const base = {
    organizationId: 'o',
    direction: 'INBOUND',
    partyId: 'p',
    treasuryAccountId: 'a',
    amount: '100',
    allocations: [
      { receivableId: 'r1', amount: '60' },
      { receivableId: 'r2', amount: '40' },
    ],
  }

  test('aceita alocações que somam o montante e herda a moeda da conta', ({ assert }) => {
    const issues: Issue[] = []
    const value = normalizePayment(base, 'AOA', '2026-10-29', issues)
    assert.isEmpty(issues)
    assert.equal(value?.currency, 'AOA')
    assert.equal(value?.occurredOn, '2026-10-29')
    assert.equal(value?.method, 'TRANSFER')
    assert.equal(value?.allocations[1]?.receivableId, 'r2')
  })

  test('recusa soma diferente, repetidos, sentido errado, montantes inválidos e conta inexistente', ({
    assert,
  }) => {
    const run = (input: Record<string, unknown>, currency: string | null = 'AOA') =>
      issuesOf((i) => normalizePayment({ ...base, ...input }, currency, '2026-10-29', i))
    assert.include(run({ amount: '101' }), 'allocations:ALLOCATION_MISMATCH')
    assert.include(
      run({
        allocations: [
          { receivableId: 'r1', amount: '50' },
          { receivableId: 'r1', amount: '50' },
        ],
      }),
      'allocations[1].receivableId:DUPLICATE'
    )
    assert.include(
      run({ allocations: [{ payableId: 'x', amount: '100' }] }),
      'allocations[0].receivableId:REQUIRED'
    )
    assert.include(run({ amount: '0' }), 'amount:INVALID_MONEY')
    assert.include(run({ amount: '10.12345' }), 'amount:INVALID_MONEY')
    assert.include(run({ amount: -5 }), 'amount:INVALID_MONEY')
    assert.include(run({ direction: 'SIDEWAYS' }), 'direction:INVALID_DIRECTION')
    assert.include(run({ method: 'CHEQUE' }), 'method:INVALID_METHOD')
    assert.include(run({ occurredOn: '2026-02-30' }), 'occurredOn:INVALID_DATE')
    assert.include(run({ allocations: [] }), 'allocations:REQUIRED')
    assert.include(run({}, null), 'treasuryAccountId:UNKNOWN_ACCOUNT')
  })

  test('pagamentos a fornecedores alocam pagáveis', ({ assert }) => {
    const issues: Issue[] = []
    const value = normalizePayment(
      { ...base, direction: 'OUTBOUND', allocations: [{ payableId: 'b1', amount: '100' }] },
      'AOA',
      '2026-10-29',
      issues
    )
    assert.isEmpty(issues)
    assert.equal(value?.allocations[0]?.payableId, 'b1')
    assert.isNull(value?.allocations[0]?.receivableId)
  })
})

test.group('finanças | contas e facturas de fornecedor', () => {
  test('a conta herda a moeda base e não muda o que é imutável', ({ assert }) => {
    const issues: Issue[] = []
    const account = normalizeAccount(
      { organizationId: 'o', code: 'CAIXA', name: 'Caixa', type: 'CASH' },
      null,
      'AOA',
      issues
    )
    assert.isEmpty(issues)
    assert.equal(account?.currency, 'AOA')
    const changes = issuesOf((i) =>
      normalizeAccount({ currency: 'USD', type: 'BANK', code: 'X' }, account, 'AOA', i)
    )
    assert.sameMembers(changes, ['currency:IMMUTABLE', 'type:IMMUTABLE', 'code:IMMUTABLE'])
  })

  test('cada linha arredonda uma vez e o total é a soma das linhas', ({ assert }) => {
    const issues: Issue[] = []
    const line = supplierInvoiceLine(
      { description: 'Renda', quantity: '3', unitPrice: '33.3333', taxRate: '14' },
      'l',
      'HALF_UP',
      issues
    )
    assert.isEmpty(issues)
    assert.equal(line?.netAmount, '99.9999')
    assert.equal(line?.taxAmount, '14.0000')
    assert.equal(line?.total, '113.9999')
    const other = supplierInvoiceLine(
      { description: 'Água', quantity: '1', unitPrice: '10' },
      'l',
      'HALF_UP',
      []
    )
    assert.deepEqual(sumInvoiceLines([line!, other!]), {
      net: '109.9999',
      tax: '14.0000',
      total: '123.9999',
    })
  })

  test('meio arredonda para cima ou para o par conforme a configuração', ({ assert }) => {
    const input = { description: 'x', quantity: '1', unitPrice: '0.5', taxRate: '1' }
    // imposto = 0,5 × 1 % = 0,005 → 0,0050 (4 casas: exacto), por isso força-se o meio com preço de 0,0005
    const tiny = { ...input, unitPrice: '0.0005', taxRate: '50' }
    assert.equal(supplierInvoiceLine(tiny, 'l', 'HALF_UP', [])?.taxAmount, '0.0003')
    assert.equal(supplierInvoiceLine(tiny, 'l', 'HALF_EVEN', [])?.taxAmount, '0.0002')
  })

  test('recusa descrição, quantidade, preço e taxa inválidos', ({ assert }) => {
    const run = (input: Record<string, unknown>) =>
      issuesOf((i) => supplierInvoiceLine(input as never, 'l', 'HALF_UP', i))
    assert.deepEqual(run({ quantity: '0', unitPrice: '-1', taxRate: '101' }), [
      'l.description:REQUIRED',
      'l.quantity:INVALID_QUANTITY',
      'l.unitPrice:INVALID_MONEY',
      'l.taxRate:INVALID_RATE',
    ])
  })
})

test.group('finanças | conferência a três vias e crédito', () => {
  const line = {
    invoiceLineId: 'i1',
    purchaseLineId: 'p1',
    invoicedQuantity: '4',
    alreadyInvoiced: '0',
    receivedQuantity: '6',
    orderedUnitCost: '5.0000',
    invoicedUnitPrice: '5.0000',
  }

  test('conforme quando se factura o recebido ao preço da encomenda', ({ assert }) => {
    assert.isEmpty(matchInvoice([line]))
    assert.isEmpty(matchInvoice([{ ...line, invoicedQuantity: '6' }]))
    assert.isEmpty(matchInvoice([{ ...line, invoicedUnitPrice: '4.9999' }]))
  })

  test('diverge acima do recebido (contando o já facturado) e acima do preço', ({ assert }) => {
    assert.deepEqual(
      matchInvoice([{ ...line, invoicedQuantity: '7' }]).map((d) => d.code),
      ['NOT_RECEIVED']
    )
    assert.deepEqual(
      matchInvoice([{ ...line, alreadyInvoiced: '3' }]).map((d) => d.code),
      ['NOT_RECEIVED']
    )
    assert.deepEqual(
      matchInvoice([{ ...line, invoicedUnitPrice: '5.0001' }]).map((d) => d.code),
      ['PRICE_ABOVE_ORDER']
    )
    assert.lengthOf(matchInvoice([{ ...line, invoicedQuantity: '9', invoicedUnitPrice: '6' }]), 2)
  })

  test('o limite 0 não controla; senão a exposição mais o novo valor não o pode exceder', ({
    assert,
  }) => {
    assert.isNull(creditHeadroom('0.0000', '500.0000'))
    assert.equal(creditHeadroom('1000.0000', '400.0000'), '600.0000')
    assert.equal(creditHeadroom('1000.0000', '1500.0000'), '0.0000')
    assert.isFalse(exceedsCredit('0.0000', '999999', '999999'))
    assert.isFalse(exceedsCredit('1000.0000', '400.0000', '600.0000'))
    assert.isTrue(exceedsCredit('1000.0000', '400.0000', '600.0001'))
  })
})
