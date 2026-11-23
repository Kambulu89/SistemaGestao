import { test } from '@japa/runner'
import {
  normalizeAddress,
  normalizeCreditLimit,
  normalizeCustomer,
  normalizeSegment,
  normalizeStatusChange,
  versionHash,
} from '#modules/sales/domain/customers'

const codes = (issues: { code: string }[]) => issues.map((i) => i.code)
const data = (extra: Record<string, unknown> = {}) => ({
  code: 'CLI-1',
  name: 'Cliente',
  partnerType: 'ORGANIZATION',
  taxId: '5417000071',
  countryCode: 'AO',
  email: null,
  billingAddress: {
    addressLine: 'Rua 1',
    city: 'Luanda',
    municipality: null,
    province: null,
    postalCode: null,
    countryCode: 'AO',
  },
  ...extra,
})

test.group('Vendas | clientes — regras (10.1)', () => {
  test('condições de venda e limite de crédito', ({ assert }) => {
    assert.deepEqual(
      normalizeCustomer({ currency: ' usd ', paymentTermsDays: '30', notes: ' ok ' }, true),
      {
        v: { currency: 'USD', paymentTermsDays: 30, notes: 'ok' },
        issues: [],
      }
    )
    assert.sameMembers(
      codes(normalizeCustomer({ currency: 'KWZA', paymentTermsDays: 366 }, true).issues),
      ['INVALID', 'INVALID']
    )
    assert.deepEqual(normalizeCustomer({}, false), { v: {}, issues: [] })
    assert.deepEqual(normalizeCreditLimit('250000,5'), { value: '250000.50', issues: [] })
    assert.deepEqual(normalizeCreditLimit(''), { value: null, issues: [] })
    assert.deepEqual(normalizeCreditLimit('007'), { value: '7.00', issues: [] })
    assert.deepEqual(codes(normalizeCreditLimit('-1').issues), ['INVALID'])
    assert.deepEqual(codes(normalizeCreditLimit('1.234').issues), ['INVALID'])
  })

  test('moradas, segmentos e estado', ({ assert }) => {
    const a = normalizeAddress(
      { kind: 'BILLING', label: 'Sede', addressLine: 'Rua 1', countryCode: 'ao' },
      true
    )
    assert.deepEqual(a, {
      v: { kind: 'BILLING', label: 'Sede', addressLine: 'Rua 1', countryCode: 'AO' },
      issues: [],
    })
    assert.sameMembers(codes(normalizeAddress({ kind: 'HOME', label: 'x' }, true).issues), [
      'INVALID',
      'LENGTH',
      'LENGTH',
      'INVALID',
    ])
    assert.deepEqual(normalizeSegment({ code: 'grossista', name: 'Grossistas' }, true).v, {
      code: 'GROSSISTA',
      name: 'Grossistas',
    })
    assert.deepEqual(codes(normalizeSegment({ code: '-x', name: 'G' }, true).issues), [
      'INVALID_CODE',
      'LENGTH',
    ])
    assert.deepEqual(normalizeStatusChange({ status: 'ACTIVE' }), {
      status: 'ACTIVE',
      reason: null,
      issues: [],
    })
    assert.deepEqual(codes(normalizeStatusChange({ status: 'BLOCKED', reason: 'x' }).issues), [
      'REQUIRED',
    ])
    assert.deepEqual(codes(normalizeStatusChange({ status: 'GONE' }).issues), [
      'INVALID',
      'REQUIRED',
    ])
  })

  test('impressão digital da versão: mesmos dados, mesma versão; qualquer mudança fiscal, outra', ({
    assert,
  }) => {
    assert.equal(versionHash(data()), versionHash(data()))
    assert.notEqual(versionHash(data()), versionHash(data({ name: 'Cliente, S.A.' })))
    assert.notEqual(versionHash(data()), versionHash(data({ taxId: '5417000072' })))
    assert.notEqual(
      versionHash(data()),
      versionHash(data({ billingAddress: { ...data().billingAddress, addressLine: 'Rua 2' } }))
    )
    assert.lengthOf(versionHash(data()), 64)
  })
})
