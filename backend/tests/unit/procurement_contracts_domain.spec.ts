import { test } from '@japa/runner'
import {
  addMonths,
  committedValue,
  contractFitIssues,
  effectiveStatus,
  normalizeContractHeader,
  normalizePrices,
  normalizeSlas,
  renewalDue,
} from '#modules/procurement/domain/contracts'

const N = (v: number) => BigInt(Math.round(v * 1_000_000))

test.group('Compras | contratos: regras', () => {
  test('estado efectivo pelas datas e alerta de renovação', ({ assert }) => {
    const c = { status: 'ACTIVE' as const, startDate: '2026-01-01', endDate: '2026-12-31' }
    assert.equal(effectiveStatus(c, '2025-12-31'), 'NOT_STARTED')
    assert.equal(effectiveStatus(c, '2026-12-31'), 'ACTIVE')
    assert.equal(effectiveStatus(c, '2027-01-01'), 'EXPIRED')
    assert.equal(effectiveStatus({ ...c, status: 'SUSPENDED' }, '2026-06-01'), 'SUSPENDED')
    const r = { status: 'ACTIVE' as const, endDate: '2026-12-31', renewalNoticeDays: 30 }
    assert.isFalse(renewalDue(r, '2026-11-30'))
    assert.isTrue(renewalDue(r, '2026-12-01'))
    assert.isFalse(renewalDue(r, '2027-01-01'))
    assert.isFalse(renewalDue({ ...r, status: 'SUSPENDED' }, '2026-12-15'))
  })

  test('renovação por meses: fim de mês e anos', ({ assert }) => {
    assert.equal(addMonths('2026-01-31', 1), '2026-02-28')
    assert.equal(addMonths('2028-01-31', 1), '2028-02-29')
    assert.equal(addMonths('2026-12-15', 12), '2027-12-15')
    assert.equal(addMonths('2026-11-30', 3), '2027-02-28')
  })

  test('valor em vigor de uma ordem: líquido proporcional ao não cancelado', ({ assert }) => {
    assert.equal(
      committedValue([
        { quantity: N(6), cancelled: N(4), net: 600_000n },
        { quantity: N(3), cancelled: N(1), net: 100n },
      ]),
      200_000n + 67n
    )
    assert.equal(committedValue([{ quantity: N(1), cancelled: N(1), net: 999n }]), 0n)
  })

  test('cabeçalho, preços e SLA: validações', ({ assert }) => {
    const ok = normalizeContractHeader({
      title: 'Bombas',
      object: 'Fornecimento',
      startDate: '2026-01-01',
      endDate: '2026-12-31',
      maxAmount: '1000.5',
    })
    assert.deepEqual(ok.issues, [])
    assert.equal(ok.values.maxAmount, 100_050n)
    assert.equal(ok.values.renewalNoticeDays, 30)
    const bad = normalizeContractHeader({
      title: 'B',
      object: '',
      startDate: '2026-02-30',
      endDate: '2026-01-01',
      maxAmount: '-1',
      autoRenew: true,
      renewalNoticeDays: 400,
    })
    assert.includeMembers(
      bad.issues.map((i) => `${i.path}:${i.code}`),
      [
        'title:LENGTH',
        'object:REQUIRED',
        'startDate:INVALID',
        'maxAmount:INVALID',
        'renewalNoticeDays:INVALID',
        'renewalMonths:REQUIRED',
      ]
    )
    assert.equal(
      normalizeContractHeader({ ...ok.values, maxAmount: '1', endDate: '2025-12-31' }).issues[0]
        .code,
      'BEFORE_START'
    )
    const pid = '00000000-0000-4000-8000-000000000001'
    assert.deepEqual(
      normalizePrices([
        { productId: pid, unitPrice: '1' },
        { productId: pid, unitPrice: 'x' },
      ]).issues.map((i) => i.code),
      ['INVALID', 'DUPLICATE']
    )
    assert.deepEqual(
      normalizeSlas([
        { metric: 'FILL_RATE', target: '101' },
        { metric: 'OTHER', target: '1' },
        { metric: 'NOPE', target: '1' },
      ]).issues.map((i) => i.code),
      ['INVALID', 'REQUIRED', 'INVALID']
    )
  })

  test('encaixe da ordem no contrato', ({ assert }) => {
    const c = {
      status: 'ACTIVE' as const,
      legalEntityId: 'le',
      supplierId: 's',
      currency: 'AOA',
      startDate: '2026-01-01',
      endDate: '2026-12-31',
    }
    const o = { legalEntityId: 'le', supplierId: 's', currency: 'AOA', orderDate: '2026-06-01' }
    assert.deepEqual(contractFitIssues(c, o), [])
    assert.deepEqual(
      contractFitIssues(
        { ...c, status: 'SUSPENDED' },
        { ...o, supplierId: 'x', currency: 'USD' }
      ).map((i) => i.code),
      ['CONTRACT_NOT_ACTIVE', 'CONTRACT_OTHER_SUPPLIER', 'CONTRACT_OTHER_CURRENCY']
    )
    assert.deepEqual(
      contractFitIssues(c, { ...o, orderDate: '2027-01-01', legalEntityId: 'y' }).map(
        (i) => i.code
      ),
      ['CONTRACT_OUT_OF_TERM', 'CONTRACT_OTHER_ENTITY']
    )
  })
})
