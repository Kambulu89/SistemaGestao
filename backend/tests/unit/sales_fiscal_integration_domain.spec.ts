import { test } from '@japa/runner'
import {
  type FiscalPayload,
  PROVIDER_INFO,
  retryDelayMinutes,
  validatePayload,
} from '#modules/sales/domain/fiscal_integration'

const base = (): FiscalPayload => ({
  format: 'SG-SIM-1',
  simulation: true,
  documentType: 'FT',
  number: 'FT A/1',
  date: '2026-06-01',
  issuer: { taxId: '5000000931', name: 'Entidade A' },
  customer: { taxId: '5417000071', name: 'Cliente', countryCode: 'AO' },
  currency: 'AOA',
  exchangeRate: '1.0000000000',
  reference: null,
  reason: null,
  lines: [
    {
      n: 1,
      description: 'Serviço',
      quantity: '1.000000',
      unitPrice: '500.0000',
      net: '500.00',
      taxes: [
        {
          code: 'T',
          kind: 'TAX',
          rate: '10.0000',
          base: '500.00',
          amount: '50.00',
          exemptionCode: null,
        },
      ],
    },
  ],
  totals: { net: '500.00', tax: '50.00', gross: '550.00', withholding: '0.00', payable: '550.00' },
  documentHash: 'x',
})

test.group('Vendas | integração fiscal — regras (10.9)', () => {
  test('validação local: coerente passa; totais, NIF, data, isenção e referência da nota', ({
    assert,
  }) => {
    assert.deepEqual(validatePayload(base(), '2026-06-30'), [])
    const p = base()
    p.issuer.taxId = null
    p.totals.net = '499.00'
    p.date = '2026-07-01'
    p.lines[0].taxes[0].rate = '0.0000'
    const paths = validatePayload(p, '2026-06-30').map((i) => i.path)
    assert.includeMembers(paths, [
      'issuer.taxId',
      'totals.net',
      'totals.gross',
      'date',
      'lines.0.taxes',
    ])
    const nc = base()
    nc.documentType = 'NC'
    assert.include(
      validatePayload(nc, '2026-06-30').map((i) => i.path),
      'reference'
    )
    const pay = base()
    pay.totals.withholding = '10.00'
    assert.include(
      validatePayload(pay, '2026-06-30').map((i) => i.path),
      'totals.payable'
    )
  })

  test('espera crescente com tecto e adaptador oficial indisponível', ({ assert }) => {
    assert.deepEqual([1, 2, 3, 4, 7, 10].map(retryDelayMinutes), [1, 2, 4, 8, 60, 60])
    assert.isFalse(PROVIDER_INFO.AGT_OFFICIAL.available)
    assert.isTrue(PROVIDER_INFO.LOCAL_SIMULATOR.available)
    assert.match(PROVIDER_INFO.LOCAL_SIMULATOR.label, /não comunica com a AGT/)
  })
})
