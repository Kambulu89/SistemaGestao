import { test } from '@japa/runner'
import { ApiRequest } from '@japa/api-client'
import db from '@adonisjs/lucid/services/db'
import {
  as,
  cleanDatabase,
  createRole,
  memberWithRoles,
  type Session,
} from '#tests/support/fixtures'
import { ledger, ok } from '#tests/support/accounting'

// O PDF chega em bytes (sem isto o cliente de testes não guarda o corpo de tipos binários).
ApiRequest.addParser('application/pdf', (res: any, done: any) => {
  const chunks: Buffer[] = []
  res.on('data', (c: Buffer) => chunks.push(c))
  res.on('end', () => done(null, Buffer.concat(chunks)))
})

const H = '/api/v1/hr'
const P = `${H}/payroll`
const A = '/api/v1/accounting'
const owner = () => db.connection('owner')
const code = (r: any) => r.body().error?.code
const details = (r: any) => (r.body().error?.details ?? []).map((d: any) => d.code)

/** Valores de TESTE (não são a tabela oficial). */
const RULES = {
  code: 'TESTE',
  name: 'Regras de teste',
  currency: 'AOA',
  validFrom: '2026-01-01',
  inssEmployeeRate: '3',
  inssEmployerRate: '8',
  baseIrtSubject: true,
  baseInssSubject: true,
  irtBaseDeductsInss: true,
  dayBasis: 'FIXED_30',
  legalReference: 'Valores de teste do mecanismo — não são a tabela oficial',
  brackets: [
    { lower: '0', upper: '100000', fixedAmount: '0', rate: '0', excessOver: '0' },
    { lower: '100000.01', upper: null, fixedAmount: '0', rate: '10', excessOver: '100000' },
  ],
  testCases: [
    {
      description: 'Salário de 200 000',
      source: 'Exemplo de teste',
      baseSalary: '200000',
      expectedInssEmployee: '6000',
      expectedIrt: '9400',
    },
  ],
}

async function roleMember(client: any, admin: Session, roleCode: string, permissions: string[]) {
  const m = await memberWithRoles(client, admin, [])
  if (permissions.length) {
    const role = await createRole(client, admin, roleCode, permissions)
    ok(
      await as(client, admin).post(`/api/v1/members/${m.memberId}/roles`, {
        roleId: role.id,
        scopeType: 'TENANT',
      }),
      200
    )
  }
  return m
}

/** Contabilidade (plano do `ledger` + contas de salários) e um lote regular de outubro fechado. */
async function setup(client: any) {
  const L = await ledger(client)
  const api = L.api
  const account = async (c: string, level: string, nature: string, parentId: string | null) =>
    ok(
      await api.post(`${A}/accounts`, {
        chartId: L.chart.id,
        code: c,
        name: `Conta ${c}`,
        level,
        nature,
        parentId,
        ...(level === 'CLASS' ? {} : { postable: true }),
      })
    )
  const c2 = await account('2', 'CLASS', 'LIABILITY', null)
  const payable = await account('23', 'ACCOUNT', 'LIABILITY', c2.id)
  const irt = await account('24', 'ACCOUNT', 'LIABILITY', c2.id)
  const inss = await account('25', 'ACCOUNT', 'LIABILITY', c2.id)
  const c6 = await account('6', 'CLASS', 'EXPENSE', null)
  const wages = await account('63', 'ACCOUNT', 'EXPENSE', c6.id)
  const charges = await account('64', 'ACCOUNT', 'EXPENSE', c6.id)

  const rs = ok(await api.post(`${P}/rule-sets`, RULES))
  const c = ok(
    await api.post(`${P}/rule-sets/${rs.id}/confirm`, {
      note: 'Conferido',
      expectedVersion: rs.version,
    }),
    200
  )
  ok(await api.post(`${P}/rule-sets/${rs.id}/publish`, { expectedVersion: c.version }), 200)

  const e = ok(
    await api.post(`${H}/employees`, {
      code: 'C1',
      fullName: 'Ana Recibo',
      legalEntityId: L.le.id,
      hireDate: '2026-01-05',
      taxId: '000111222LA333',
      socialSecurityNumber: '12345678',
      bankIban: 'AO88004000003514200123456',
    })
  )
  const ct = ok(
    await api.post(`${H}/employees/${e.id}/contracts`, {
      code: 'CT-1',
      contractType: 'PERMANENT',
      startDate: '2026-01-05',
      weeklyHours: '40',
      currency: 'AOA',
      baseSalary: '200000',
    })
  )
  ok(await api.post(`${H}/contracts/${ct.id}/activate`, { expectedVersion: ct.version }), 200)
  const approver = await roleMember(client, L.s, 'aprova', [
    'hr.payroll.read',
    'hr.payroll.approve',
  ])
  const AP = as(client, approver.session)
  const act = (who: any, r: any, path: string, body: Record<string, unknown> = {}) =>
    who.post(`${P}/runs/${r.id}/${path}`, { ...body, expectedVersion: r.version })
  let run = ok(
    await api.post(`${P}/runs`, { legalEntityId: L.le.id, period: '2026-10', kind: 'REGULAR' })
  )
  run = ok(await act(api, run, 'calculate'), 200)
  run = ok(await act(api, run, 'submit'), 200)
  run = ok(await act(AP, run, 'decision', { decision: 'APPROVE' }), 200)
  const open = run
  run = ok(await act(api, run, 'close'), 200)
  return { ...L, payable, irt, inss, wages, charges, e, run, open, approver, AP, act }
}

const rule = (L: any, ruleCode: string, event: string, lines: unknown[]) =>
  L.api.post(`${A}/posting-rules`, {
    legalEntityId: L.le.id,
    code: ruleCode,
    name: ruleCode,
    source: 'payroll',
    event,
    journalId: L.journal.id,
    autoPost: true,
    validFrom: '2026-01-01',
    lines,
  })

test.group('RH | recibos, pagamento e contabilização (7.9)', (group) => {
  group.each.setup(() => cleanDatabase())

  test('fechado ≠ pago: obrigações do fecho, pagamentos parciais e só de acréscimo', async ({
    client,
    assert,
  }) => {
    const L = await setup(client)
    let s = ok(await L.api.get(`${P}/runs/${L.run.id}/payments`), 200)
    assert.equal(s.paymentStatus, 'UNPAID')
    assert.deepEqual(
      s.obligations.map((o: any) => [o.kind, o.amount, o.status]),
      [
        ['NET_PAY', '184600.00', 'UNPAID'],
        ['IRT', '9400.00', 'UNPAID'],
        ['INSS', '22000.00', 'UNPAID'], // 6 000 do trabalhador + 16 000 da empresa
      ]
    )
    const net = s.obligations[0]
    const PAY = (body: Record<string, unknown>, who = L.api, o = net) =>
      who.post(`${P}/obligations/${o.id}/payments`, { ...body, expectedVersion: o.version })
    const today = new Date().toISOString().slice(0, 10)
    assert.include(
      details(await PAY({ amount: '200000', paidOn: today, reference: 'TRF-1' })),
      'OVERPAYMENT'
    )
    assert.include(
      details(await PAY({ amount: '1', paidOn: '2999-01-01', reference: 'TRF-1' })),
      'FUTURE'
    )
    assert.include(
      details(
        await PAY({
          amount: '1',
          paidOn: today,
          reference: 'TRF-1',
          bankAccountId: '00000000-0000-4000-8000-000000000000',
        })
      ),
      'INVALID'
    )
    // Quem aprova salários não regista pagamentos.
    assert.equal(
      code(await PAY({ amount: '1', paidOn: today, reference: 'X' }, L.AP)),
      'OUT_OF_SCOPE'
    )
    ok(await PAY({ amount: '100000', paidOn: today, reference: 'TRF-1' }))
    assert.equal(
      code(await PAY({ amount: '1', paidOn: today, reference: 'TRF-2' })),
      'VERSION_CONFLICT'
    )
    s = ok(await L.api.get(`${P}/runs/${L.run.id}/payments`), 200)
    assert.equal(s.paymentStatus, 'PARTIAL')
    assert.equal(s.obligations[0].outstanding, '84600.00')
    ok(await PAY({ amount: '84600', paidOn: today, reference: 'TRF-2' }, L.api, s.obligations[0]))
    s = ok(await L.api.get(`${P}/runs/${L.run.id}/payments`), 200)
    assert.equal(s.paymentStatus, 'PAID')
    assert.equal(s.obligations[0].status, 'PAID')
    assert.lengthOf(s.obligations[0].payments, 2)
    await assert.rejects(() =>
      owner().rawQuery(
        `update payroll_obligation_payments set amount = 1 where obligation_id = ?`,
        [net.id]
      )
    )
    await assert.rejects(() =>
      owner().rawQuery(`update payroll_obligations set paid_amount = amount + 1 where id = ?`, [
        net.id,
      ])
    )
    // Lote por fechar não tem obrigações nem pagamentos.
    const other = ok(
      await L.api.post(`${P}/runs`, { legalEntityId: L.le.id, period: '2026-11', kind: 'REGULAR' })
    )
    const o2 = ok(await L.api.get(`${P}/runs/${other.id}/payments`), 200)
    assert.lengthOf(o2.obligations, 0)
    assert.isFalse(o2.access.pay)
  })

  test('contabilização: salários e pagamentos uma só vez, pelas regras da empresa', async ({
    client,
    assert,
  }) => {
    const L = await setup(client)
    // Sem regra configurada na contabilidade, nada é lançado.
    const none = await L.api.post(`${P}/runs/${L.run.id}/accounting`)
    assert.equal(none.status(), 422)
    assert.include(details(none), 'NO_RULE')
    ok(
      await rule(L, 'SAL', 'salaries', [
        { side: 'DEBIT', accountId: L.wages.id, amountKey: 'gross' },
        { side: 'DEBIT', accountId: L.charges.id, amountKey: 'inssEmployer' },
        { side: 'CREDIT', accountId: L.payable.id, amountKey: 'net' },
        { side: 'CREDIT', accountId: L.irt.id, amountKey: 'irt' },
        { side: 'CREDIT', accountId: L.inss.id, amountKey: 'inssTotal' },
      ])
    )
    ok(
      await rule(L, 'SALPAGO', 'net_pay_paid', [
        { side: 'DEBIT', accountId: L.payable.id, amountKey: 'amount' },
        { side: 'CREDIT', accountId: L.cash.id, amountKey: 'amount' },
      ])
    )
    const s = ok(await L.api.get(`${P}/runs/${L.run.id}/payments`), 200)
    const net = s.obligations.find((o: any) => o.kind === 'NET_PAY')
    const today = new Date().toISOString().slice(0, 10)
    ok(
      await L.api.post(`${P}/obligations/${net.id}/payments`, {
        amount: '184600',
        paidOn: today,
        reference: 'TRF-1',
        expectedVersion: net.version,
      })
    )
    assert.equal(ok(await L.api.post(`${P}/runs/${L.run.id}/accounting`), 200).posted, 2)
    // Repetir não duplica.
    assert.equal(ok(await L.api.post(`${P}/runs/${L.run.id}/accounting`), 200).posted, 0)
    const entries = await owner().rawQuery(
      `select e.reference, sum(l.debit)::text as debit, sum(l.credit)::text as credit, e.status
         from journal_entries e join journal_lines l on l.tenant_id = e.tenant_id and l.entry_id = e.id
        where e.tenant_id = (select tenant_id from legal_entities where id = ?) group by e.id order by e.reference`,
      [L.le.id]
    )
    assert.deepEqual(
      entries.rows.map((x: any) => [x.reference, x.debit, x.credit, x.status]),
      [
        [L.run.code, '216000.000000', '216000.000000', 'POSTED'], // 200 000 + 16 000 patronal
        [`${L.run.code}:NET_PAY:1`, '184600.000000', '184600.000000', 'POSTED'],
      ]
    )
    const after = ok(await L.api.get(`${P}/runs/${L.run.id}/payments`), 200)
    assert.lengthOf(after.accounting.accrued, 1)
    assert.equal(after.accounting.paymentsAccounted, 1)
    // Um pagamento de IRT sem regra própria: falha sem deixar nada a meio.
    const irtObl = after.obligations.find((o: any) => o.kind === 'IRT')
    ok(
      await L.api.post(`${P}/obligations/${irtObl.id}/payments`, {
        amount: '9400',
        paidOn: today,
        reference: 'DAR-10',
        expectedVersion: irtObl.version,
      })
    )
    assert.include(details(await L.api.post(`${P}/runs/${L.run.id}/accounting`)), 'NO_RULE')
    // Quem só aprova não contabiliza; lote por fechar também não.
    assert.equal(code(await L.AP.post(`${P}/runs/${L.run.id}/accounting`)), 'OUT_OF_SCOPE')
  })

  test('recibos em PDF privados: o próprio e quem processa; só de lotes fechados', async ({
    client,
    assert,
  }) => {
    const L = await setup(client)
    const self = await roleMember(client, L.s, 'nada', [])
    ok(
      await L.api.patch(`${H}/employees/${L.e.id}`, {
        membershipId: self.memberId,
        expectedVersion: L.e.version,
      }),
      200
    )
    const S = as(client, self.session)
    const mine = ok(await S.get(`${H}/payslips`), 200)
    assert.lengthOf(mine, 1)
    assert.equal(mine[0].net, '184600.00')
    assert.isFalse(mine[0].paid)
    const pdf = await S.get(`${H}/payslips/${mine[0].id}`)
    assert.equal(pdf.status(), 200)
    assert.equal(pdf.header('content-type'), 'application/pdf')
    assert.equal(pdf.header('cache-control'), 'private, no-store')
    const text = (pdf.body() as Buffer).toString('latin1')
    assert.isTrue(text.startsWith('%PDF-1.4'))
    for (const t of ['Recibo de vencimento', 'Ana Recibo', '184 600,00', 'por pagar', '3456'])
      assert.include(text, t)
    assert.notInclude(text, 'AO88004000003514200123456') // IBAN mascarado

    // Outro colaborador sem permissões não vê o recibo; quem processa vê.
    const stranger = await roleMember(client, L.s, 'outro', [])
    assert.lengthOf(ok(await as(client, stranger.session).get(`${H}/payslips`), 200), 0)
    assert.equal(
      (await as(client, stranger.session).get(`${H}/payslips/${mine[0].id}`)).status(),
      404
    )
    assert.equal((await L.api.get(`${H}/payslips/${mine[0].id}`)).status(), 200)

    // Lote por fechar: sem recibo.
    const other = ok(
      await L.api.post(`${P}/runs`, { legalEntityId: L.le.id, period: '2026-11', kind: 'REGULAR' })
    )
    const calc = ok(await L.act(L.api, other, 'calculate'), 200)
    assert.equal(code(await L.api.get(`${H}/payslips/${calc.results[0].id}`)), 'NOT_CLOSED')
    const events = await owner().rawQuery(
      `select metadata from audit_events where action = 'hr.payroll.payslip_downloaded'`
    )
    assert.equal(events.rows.length, 2)
  })
})
