import { test } from '@japa/runner'
import {
  approvalTransition,
  canReceive,
  fits,
  normalizeSupplierCategory,
  normalizeReceiptLine,
  normalizeSupplier,
  purchaseBlocker,
  purchaseLineValues,
  remaining,
  statusAfterReceiving,
  sumLines,
  type Issue,
} from '#modules/procurement/domain/procurement'

const base = { partyId: 'p1', organizationId: 'o1', code: 'FOR-1' }

test.group('compras | fornecedores', () => {
  test('valida o prazo, a moeda e exige motivo para bloquear', ({ assert }) => {
    const issues: Issue[] = []
    const ok = normalizeSupplier({ ...base, paymentTermDays: 30 }, null, 'AOA', issues)
    assert.isEmpty(issues)
    assert.deepInclude(ok, { currency: 'AOA', status: 'ACTIVE', statusReason: null })
    const bad: Issue[] = []
    normalizeSupplier(
      { ...base, code: '!', paymentTermDays: -1, currency: 'aoa', status: 'BLOCKED' },
      null,
      'AOA',
      bad
    )
    assert.sameMembers(
      bad.map((i) => i.code),
      ['INVALID_CODE', 'INVALID_TERMS', 'INVALID_CURRENCY', 'REASON_REQUIRED']
    )
  })

  test('só fornecedores activos recebem novas encomendas', ({ assert }) => {
    const ok = { status: 'ACTIVE' as const, approvalStatus: 'PENDING' as const, critical: false }
    assert.isNull(purchaseBlocker(ok))
    assert.equal(purchaseBlocker({ ...ok, status: 'BLOCKED' })?.code, 'SUPPLIER_BLOCKED')
    assert.equal(purchaseBlocker({ ...ok, status: 'INACTIVE' })?.code, 'SUPPLIER_INACTIVE')
  })

  test('homologação rejeitada, suspensa ou caducada bloqueia; crítico exige homologação', ({
    assert,
  }) => {
    const ok = { status: 'ACTIVE' as const, critical: false }
    assert.equal(purchaseBlocker({ ...ok, approvalStatus: 'REJECTED' })?.code, 'SUPPLIER_REJECTED')
    assert.equal(
      purchaseBlocker({ ...ok, approvalStatus: 'SUSPENDED' })?.code,
      'SUPPLIER_SUSPENDED'
    )
    assert.equal(
      purchaseBlocker({ ...ok, approvalStatus: 'EXPIRED' })?.code,
      'SUPPLIER_APPROVAL_EXPIRED'
    )
    assert.isNull(purchaseBlocker({ ...ok, approvalStatus: 'UNDER_REVIEW' }))
    assert.equal(
      purchaseBlocker({ ...ok, critical: true, approvalStatus: 'UNDER_REVIEW' })?.code,
      'SUPPLIER_NOT_APPROVED'
    )
    assert.isNull(
      purchaseBlocker({ ...ok, critical: true, approvalStatus: 'CONDITIONALLY_APPROVED' })
    )
  })

  test('classificação: tipo, avaliação, prazo e observações', ({ assert }) => {
    const issues: Issue[] = []
    const ok = normalizeSupplier(
      { ...base, supplyType: 'SERVICES', critical: true, rating: 'B', leadTimeDays: 7 },
      null,
      'AOA',
      issues
    )
    assert.isEmpty(issues)
    assert.deepInclude(ok, { supplyType: 'SERVICES', critical: true, rating: 'B', notes: null })
    const bad: Issue[] = []
    normalizeSupplier(
      { ...base, supplyType: 'X', critical: 'sim', rating: 'E', leadTimeDays: 1.5 },
      null,
      'AOA',
      bad
    )
    assert.sameMembers(
      bad.map((i) => i.code),
      ['INVALID_SUPPLY_TYPE', 'INVALID_CRITICAL', 'INVALID_RATING', 'INVALID_LEAD_TIME']
    )
  })

  test('categoria: código imutável e designação obrigatória', ({ assert }) => {
    const issues: Issue[] = []
    const created = normalizeSupplierCategory({ code: 'MAT', name: ' Materiais ' }, null, issues)
    assert.deepEqual(created, { code: 'MAT', name: 'Materiais', description: null, active: true })
    const bad: Issue[] = []
    normalizeSupplierCategory({ code: 'OUTRO', name: '' }, created, bad)
    assert.sameMembers(
      bad.map((i) => i.code),
      ['IMMUTABLE', 'REQUIRED']
    )
  })
})

test.group('compras | homologação de fornecedores', () => {
  const state = (approvalStatus: any, requestedBy: string | null = 'm1') => ({
    approvalStatus,
    approvalValidUntil: null,
    approvalConditions: null,
    approvalRequestedByMembershipId: requestedBy,
  })
  const today = '2026-11-01'

  test('submeter põe em análise e regista quem pediu; não duas vezes', ({ assert }) => {
    const out = approvalTransition(state('PENDING', null), 'SUBMIT', {}, 'm1', today)
    assert.isTrue(out.ok)
    if (out.ok)
      assert.deepInclude(out.change, { to: 'UNDER_REVIEW', requestedByMembershipId: 'm1' })
    const again = approvalTransition(state('UNDER_REVIEW'), 'SUBMIT', {}, 'm2', today)
    assert.deepInclude(again, { ok: false, code: 'SUPPLIER_ALREADY_UNDER_REVIEW' })
    // Renovar uma homologação caducada volta a pô-la em análise.
    assert.isTrue(approvalTransition(state('EXPIRED'), 'SUBMIT', {}, 'm1', today).ok)
  })

  test('quem pediu a análise não aprova; outro aprova com validade futura', ({ assert }) => {
    const self = approvalTransition(state('UNDER_REVIEW'), 'APPROVE', {}, 'm1', today)
    assert.deepInclude(self, { ok: false, code: 'SEGREGATION_OF_DUTIES' })
    const past = approvalTransition(
      state('UNDER_REVIEW'),
      'APPROVE',
      { validUntil: today },
      'm2',
      today
    )
    assert.isFalse(past.ok)
    const ok = approvalTransition(
      state('UNDER_REVIEW'),
      'APPROVE',
      { validUntil: '2027-12-31' },
      'm2',
      today
    )
    assert.isTrue(ok.ok)
    if (ok.ok) assert.deepInclude(ok.change, { to: 'APPROVED', validUntil: '2027-12-31' })
  })

  test('condições, motivo e estados de origem', ({ assert }) => {
    const noConditions = approvalTransition(
      state('UNDER_REVIEW'),
      'APPROVE_CONDITIONALLY',
      {},
      'm2',
      today
    )
    assert.isFalse(noConditions.ok)
    if (!noConditions.ok && noConditions.kind === 'invalid') {
      assert.equal(noConditions.issues[0].code, 'CONDITIONS_REQUIRED')
    }
    const noReason = approvalTransition(state('UNDER_REVIEW'), 'REJECT', {}, 'm2', today)
    assert.isFalse(noReason.ok)
    const suspendPending = approvalTransition(
      state('PENDING'),
      'SUSPEND',
      { reason: 'x' },
      'm2',
      today
    )
    assert.deepInclude(suspendPending, { ok: false, code: 'SUPPLIER_APPROVAL_STATE' })
    const approvePending = approvalTransition(state('PENDING'), 'APPROVE', {}, 'm2', today)
    assert.deepInclude(approvePending, { ok: false, code: 'SUPPLIER_APPROVAL_STATE' })
    // Quem pediu pode rejeitar (desistir); a segregação protege a aprovação.
    assert.isTrue(
      approvalTransition(state('UNDER_REVIEW'), 'REJECT', { reason: 'Sem alvará' }, 'm1', today).ok
    )
  })
})

test.group('compras | linhas e totais', () => {
  test('líquido, imposto e total em aritmética exacta, arredondados uma vez por linha', ({
    assert,
  }) => {
    const issues: Issue[] = []
    const line = purchaseLineValues(
      { variantId: 'v', quantity: '3', unitCost: '33.3333', taxRate: '14' },
      '',
      'HALF_UP',
      issues
    )
    assert.isEmpty(issues)
    assert.deepInclude(line, { netAmount: '99.9999', taxAmount: '14.0000', total: '113.9999' })
    const second = purchaseLineValues(
      { variantId: 'v', quantity: '2', unitCost: '50' },
      '',
      'HALF_UP',
      issues
    )
    assert.deepEqual(sumLines([line!, second!]), {
      net: '199.9999',
      tax: '14.0000',
      total: '213.9999',
    })
  })

  test('recusa quantidades, custos e taxas inválidos com o caminho do campo', ({ assert }) => {
    const issues: Issue[] = []
    purchaseLineValues(
      { variantId: '', quantity: '0', unitCost: '-1', taxRate: '101' },
      'lines[2].',
      'HALF_UP',
      issues
    )
    assert.deepEqual(
      issues.map((i) => i.path),
      ['lines[2].variantId', 'lines[2].quantity', 'lines[2].unitCost', 'lines[2].taxRate']
    )
  })
})

test.group('compras | recepções', () => {
  test('o saldo por receber nunca é negativo e a quantidade tem de caber nele', ({ assert }) => {
    const balance = { ordered: 10_000_000n, received: 4_000_000n }
    assert.equal(remaining(balance), 6_000_000n)
    assert.isTrue(fits(balance, '6'))
    assert.isFalse(fits(balance, '6.000001'))
    assert.isFalse(fits(balance, '0'))
    assert.equal(remaining({ ordered: 1n, received: 5n }), 0n)
  })

  test('o estado da encomenda deriva dos saldos', ({ assert }) => {
    assert.equal(statusAfterReceiving([]), 'ORDERED')
    assert.equal(statusAfterReceiving([{ ordered: 5n, received: 0n }]), 'ORDERED')
    assert.equal(
      statusAfterReceiving([
        { ordered: 5n, received: 5n },
        { ordered: 5n, received: 1n },
      ]),
      'PARTIAL'
    )
    assert.equal(statusAfterReceiving([{ ordered: 5n, received: 5n }]), 'RECEIVED')
    assert.isTrue(canReceive('ORDERED'))
    assert.isTrue(canReceive('PARTIAL'))
    for (const status of ['DRAFT', 'RECEIVED', 'CANCELLED'] as const) {
      assert.isFalse(canReceive(status), status)
    }
  })

  test('a linha precisa da linha da encomenda, de uma quantidade positiva e valida lote e validade', ({
    assert,
  }) => {
    const issues: Issue[] = []
    assert.deepEqual(
      normalizeReceiptLine(
        { purchaseLineId: 'l1', quantity: '2.5', lotCode: ' L1 ', expiresOn: '2099-01-31' },
        '',
        issues
      ),
      { purchaseLineId: 'l1', quantity: '2.5', lotCode: 'L1', expiresOn: '2099-01-31' }
    )
    assert.isEmpty(issues)
    const bad: Issue[] = []
    normalizeReceiptLine({ quantity: '0', expiresOn: '2099-02-30' }, 'lines[0].', bad)
    assert.sameMembers(
      bad.map((i) => i.code),
      ['REQUIRED', 'INVALID_QUANTITY', 'INVALID_DATE']
    )
  })
})
