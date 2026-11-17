import { test } from '@japa/runner'
import { normalizePartner } from '#modules/partners/domain/partners'
import {
  addDays,
  normalizeSupplier,
  qualification,
  reviewIssues,
} from '#modules/procurement/domain/suppliers'

test.group('Compras | domínio dos fornecedores (9.1)', () => {
  test('validade da homologação pelos documentos obrigatórios', ({ assert }) => {
    const required = [
      { id: 'a', code: 'AGT', name: 'Certidão AGT' },
      { id: 'b', code: 'SS', name: 'Segurança social' },
      { id: 'c', code: 'ALV', name: 'Alvará' },
    ]
    const today = '2026-11-17'
    // Falta o alvará; a segurança social caducou ontem; a certidão vale até 2026-12-01 (dentro dos 30 dias).
    let q = qualification(
      required,
      [
        { documentTypeId: 'a', validUntil: '2026-12-01', status: 'ACTIVE' },
        { documentTypeId: 'b', validUntil: '2026-11-16', status: 'ACTIVE' },
        { documentTypeId: 'c', validUntil: null, status: 'INACTIVE' },
      ],
      today,
      30
    )
    assert.deepEqual(q, {
      valid: false,
      missing: ['ALV'],
      expired: ['SS'],
      expiring: ['AGT'],
      expiresOn: '2026-12-01',
    })
    // Renovados: um documento novo da segurança social e o alvará sem validade; vale até ao mais próximo.
    q = qualification(
      required,
      [
        { documentTypeId: 'a', validUntil: '2026-12-01', status: 'ACTIVE' },
        { documentTypeId: 'b', validUntil: '2026-11-16', status: 'ACTIVE' },
        { documentTypeId: 'b', validUntil: '2027-06-30', status: 'ACTIVE' },
        { documentTypeId: 'c', validUntil: null, status: 'ACTIVE' },
      ],
      today,
      10
    )
    assert.deepEqual(q, {
      valid: true,
      missing: [],
      expired: [],
      expiring: [],
      expiresOn: '2026-12-01',
    })
    // Válido até hoje, inclusive.
    assert.isTrue(
      qualification(
        required.slice(0, 1),
        [{ documentTypeId: 'a', validUntil: today, status: 'ACTIVE' }],
        today,
        0
      ).valid
    )
    assert.equal(addDays('2026-12-31', 1), '2027-01-01')
  })

  test('avaliação dos critérios e validações da ficha', ({ assert }) => {
    const criteria = [
      { id: 'q', code: 'QUAL', required: true },
      { id: 'p', code: 'PRAZO', required: false },
    ]
    const codes = (items: any[]) => reviewIssues(criteria, items).map((i) => i.code)
    assert.deepEqual(codes([{ criterionId: 'q', result: 'MET', notes: null }]), ['MISSING'])
    assert.deepEqual(
      codes([
        { criterionId: 'q', result: 'NOT_MET', notes: 'x' },
        { criterionId: 'p', result: 'MET', notes: null },
      ]),
      ['REQUIRED_NOT_MET']
    )
    assert.deepEqual(
      codes([
        { criterionId: 'q', result: 'MET', notes: null },
        { criterionId: 'p', result: 'NOT_MET', notes: null },
      ]),
      ['REQUIRED']
    )
    assert.deepEqual(
      codes([
        { criterionId: 'q', result: 'MET', notes: null },
        { criterionId: 'p', result: 'NOT_APPLICABLE', notes: null },
      ]),
      []
    )
    assert.include(codes([{ criterionId: 'zz', result: 'MET', notes: null }]), 'NOT_FOUND')

    const s = normalizeSupplier(
      {
        supplierType: 'GOODS',
        currency: 'aoa',
        paymentTermsDays: '30',
        minOrderAmount: '1500.5',
        incoterm: 'fob',
      },
      true
    )
    assert.deepEqual(s.issues, [])
    assert.deepInclude(s.v, {
      currency: 'AOA',
      paymentTermsDays: 30,
      minOrderAmount: '1500.5',
      incoterm: 'FOB',
    })
    assert.deepEqual(
      normalizeSupplier({ minOrderAmount: 12.5, paymentTermsDays: 400 }, false).issues.map(
        (i) => i.path
      ),
      ['paymentTermsDays', 'minOrderAmount']
    )
    const p = normalizePartner(
      {
        code: 'f-01',
        name: 'Fornecedor Um',
        partnerType: 'ORGANIZATION',
        countryCode: 'ao',
        taxId: '5417 0000',
      },
      true
    )
    assert.deepEqual(
      p.issues.map((i) => i.path),
      ['taxId']
    )
    assert.deepInclude(
      normalizePartner(
        {
          code: 'f-01',
          name: 'Fornecedor Um',
          partnerType: 'ORGANIZATION',
          countryCode: 'ao',
          taxId: '5417000012',
        },
        true
      ).v,
      { code: 'F-01', countryCode: 'AO', taxId: '5417000012' }
    )
  })
})
