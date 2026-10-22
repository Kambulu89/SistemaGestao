import { test } from '@japa/runner'
import {
  addressIssues,
  contactIssues,
  contactKey,
  displayNameOf,
  identityKey,
  isIsoDate,
  organizationIssues,
  personIssues,
  taxKey,
} from '#core/party/domain/party'

const TODAY = '2026-10-22'

test.group('party | chaves de duplicados', () => {
  test('identificação pessoal: tipo + número sem pontuação nem maiúsculas', ({ assert }) => {
    assert.strictEqual(identityKey('bi', '004.567-ab'), 'BI:004567AB')
    assert.strictEqual(identityKey('BI', '004567AB'), 'BI:004567AB')
    assert.isNull(identityKey('BI', null))
    assert.isNull(identityKey(null, '123'))
  })

  test('identificação fiscal: país + número normalizado', ({ assert }) => {
    assert.strictEqual(taxKey('AO', '5417 123-456'), 'AO:5417123456')
    assert.isNull(taxKey(null, '123'))
    assert.isNull(taxKey('AO', ' '))
  })

  test('contactos: email em minúsculas, telefone só dígitos, site sem esquema nem www', ({
    assert,
  }) => {
    assert.strictEqual(contactKey('EMAIL', ' Ana@Exemplo.PT '), 'ana@exemplo.pt')
    assert.strictEqual(contactKey('PHONE', '+244 923 456 789'), '+244923456789')
    assert.strictEqual(contactKey('PHONE', '(923) 456-789'), '923456789')
    assert.strictEqual(contactKey('WEBSITE', 'https://www.Exemplo.AO/'), 'exemplo.ao')
    assert.strictEqual(contactKey('WEBSITE', 'exemplo.ao/loja/'), 'exemplo.ao/loja')
  })
})

test.group('party | validação', () => {
  test('contactos por tipo', ({ assert }) => {
    assert.deepEqual(contactIssues('EMAIL', 'ana@exemplo.pt'), [])
    assert.deepEqual(contactIssues('PHONE', '+244 923 456 789'), [])
    assert.deepEqual(contactIssues('WEBSITE', 'www.exemplo.ao'), [])
    for (const [type, value] of [
      ['EMAIL', 'sem-arroba'],
      ['EMAIL', ''],
      ['PHONE', 'abc'],
      ['PHONE', '123'],
      ['PHONE', '1'.repeat(20)],
      ['WEBSITE', 'localhost'],
      ['WEBSITE', 'x'.repeat(300)],
    ] as const) {
      assert.isAbove(contactIssues(type, value).length, 0, `${type} ${value.slice(0, 20)}`)
    }
  })

  test('pessoa: nomes, datas, país e documento completo', ({ assert }) => {
    const ok = { givenNames: 'Ana', familyName: 'Silva' }
    assert.deepEqual(personIssues(ok, TODAY), [])
    const codes = (v: object) => personIssues({ ...ok, ...v }, TODAY).map((i) => i.code)
    assert.include(codes({ givenNames: ' ' }), 'REQUIRED')
    assert.include(codes({ birthDate: '2026-13-40' }), 'INVALID_DATE')
    assert.include(codes({ birthDate: '2027-01-01' }), 'FUTURE_DATE')
    assert.include(codes({ nationality: 'ao' }), 'INVALID_COUNTRY')
    assert.include(codes({ identityType: 'BI' }), 'INCOMPLETE_IDENTITY')
    assert.include(codes({ identityNumber: '123' }), 'INCOMPLETE_IDENTITY')
    assert.deepEqual(codes({ identityType: 'BI', identityNumber: '123' }), [])
    assert.deepEqual(personIssues({ nationality: 'PT' }, TODAY, true), [])
  })

  test('organização, morada e datas', ({ assert }) => {
    assert.deepEqual(organizationIssues({ legalName: 'Empresa' }), [])
    assert.include(
      organizationIssues({ legalName: ' ' }).map((i) => i.code),
      'REQUIRED'
    )
    assert.include(
      organizationIssues({ legalName: 'E', taxId: '123' }).map((i) => i.path),
      'taxCountry'
    )
    assert.deepEqual(addressIssues({ line1: 'Rua 1', city: 'Luanda', countryCode: 'AO' }), [])
    assert.lengthOf(addressIssues({ line1: '', city: '', countryCode: 'ao' }), 3)
    assert.isTrue(isIsoDate('2026-02-28'))
    assert.isFalse(isIsoDate('2026-02-30'))
    assert.isFalse(isIsoDate('28-02-2026'))
    assert.strictEqual(displayNameOf(' Ana ', ' Silva '), 'Ana Silva')
  })
})
