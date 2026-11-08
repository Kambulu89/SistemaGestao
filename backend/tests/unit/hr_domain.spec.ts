import { test } from '@japa/runner'
import { isValidIban } from '#modules/settings/index'
import { employeeChanges, normalizeEmployee } from '#modules/hr/domain/employee'
import { covers, scopeClause } from '#modules/hr/application/employee_service'

const scope = (over: Partial<Parameters<typeof covers>[0]> = {}) => ({
  tenant: false,
  own: false,
  legalEntityIds: new Set<string>(),
  branchIds: new Set<string>(),
  departmentIds: new Set<string>(),
  ...over,
})
const place = {
  legalEntityId: 'le-a',
  branchId: 'br-1',
  departmentId: 'd-1',
  membershipId: 'm-1',
}

test.group('RH | domínio do colaborador', () => {
  test('normaliza (país, IBAN, vazios) e aponta erros por campo', ({ assert }) => {
    const { values, issues } = normalizeEmployee(
      {
        code: ' C-01 ',
        fullName: 'Ana',
        nationality: 'ao',
        bankIban: 'ao36 0040 0000 6729 5030 1010 2',
        workEmail: '',
        personalEmail: 'sem-arroba',
        birthDate: '2999-01-01',
        idDocumentType: 'CARTA',
        unknownField: 'ignorado',
      },
      '2026-11-08',
      isValidIban
    )
    assert.deepInclude(values, {
      code: 'C-01',
      nationality: 'AO',
      bankIban: 'AO36004000006729503010102',
      workEmail: null,
    })
    assert.notProperty(values, 'unknownField')
    assert.sameMembers(
      issues.map((i) => `${i.path}:${i.code}`),
      ['personalEmail:INVALID_EMAIL', 'birthDate:FUTURE_DATE', 'idDocumentType:INVALID']
    )
  })

  test('auditoria: dados pessoais só como "reservado"', ({ assert }) => {
    const c = employeeChanges(
      { fullName: 'A', taxId: '111', status: 'ACTIVE' },
      { fullName: 'B', taxId: '222', status: 'ACTIVE' }
    )
    assert.deepEqual(c, {
      fullName: { from: 'A', to: 'B' },
      taxId: { from: '[RESERVADO]', to: '[RESERVADO]' },
    })
  })

  test('âmbitos: empresa, entidade, filial, departamento e próprio', ({ assert }) => {
    assert.isTrue(covers(scope({ tenant: true }), place, 'x'))
    assert.isTrue(covers(scope({ legalEntityIds: new Set(['le-a']) }), place, 'x'))
    assert.isTrue(covers(scope({ branchIds: new Set(['br-1']) }), place, 'x'))
    assert.isTrue(covers(scope({ departmentIds: new Set(['d-1']) }), place, 'x'))
    assert.isFalse(covers(scope({ departmentIds: new Set(['d-2']) }), place, 'x'))
    assert.isTrue(covers(scope({ own: true }), place, 'm-1'))
    assert.isFalse(covers(scope({ own: true }), place, 'm-2'))
    assert.isNull(scopeClause(scope(), 'm-1'))
    const clause = scopeClause(scope({ legalEntityIds: new Set(['le-a']), own: true }), 'm-1')!
    assert.equal(clause.sql, '(e.legal_entity_id = any(?::uuid[]) or e.membership_id = ?)')
    assert.deepEqual(clause.params, [['le-a'], 'm-1'])
  })
})
