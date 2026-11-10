import { test } from '@japa/runner'
import {
  coversDepartment,
  issueIssue,
  openQuantity,
  REQUISITION_CAN,
  statusAfterIssue,
} from '#modules/inventory/domain/requisitions'

const scope = (over = {}) => ({
  tenant: false,
  legalEntityIds: new Set<string>(),
  branchIds: new Set<string>(),
  departmentIds: new Set<string>(),
  ...over,
})
const dept = { id: 'd1', legalEntityId: 'le1', branchId: 'b1' }

test.group('Inventário | domínio das requisições (8.6)', () => {
  test('âmbito do departamento', ({ assert }) => {
    assert.isTrue(coversDepartment(scope({ tenant: true }), dept))
    assert.isTrue(coversDepartment(scope({ legalEntityIds: new Set(['le1']) }), dept))
    assert.isTrue(coversDepartment(scope({ branchIds: new Set(['b1']) }), dept))
    assert.isTrue(coversDepartment(scope({ departmentIds: new Set(['d1']) }), dept))
    assert.isFalse(coversDepartment(scope({ departmentIds: new Set(['d2']) }), dept))
    assert.isFalse(
      coversDepartment(scope({ branchIds: new Set(['b1']) }), { ...dept, branchId: null })
    )
  })

  test('em aberto, entregas, estados e acções', ({ assert }) => {
    const l = { quantity: 30n, issued: 20n, released: 0n, picked: 25n }
    assert.equal(openQuantity(l), 10n)
    assert.isNull(issueIssue(5n, l))
    assert.isNotNull(issueIssue(6n, l)) // acima do separado
    assert.isNotNull(issueIssue(11n, { ...l, picked: null })) // acima do em aberto
    assert.isNull(issueIssue(10n, { ...l, picked: null }))
    assert.isNotNull(issueIssue(0n, l))
    assert.equal(statusAfterIssue([{ quantity: 30n, issued: 20n, released: 10n }]), 'COMPLETED')
    assert.equal(statusAfterIssue([{ quantity: 30n, issued: 20n, released: 0n }]), 'PARTIAL')
    assert.include(REQUISITION_CAN.cancel, 'APPROVED')
    assert.notInclude(REQUISITION_CAN.cancel, 'PARTIAL')
    assert.deepEqual([...REQUISITION_CAN.approve], ['REQUESTED'])
  })
})
