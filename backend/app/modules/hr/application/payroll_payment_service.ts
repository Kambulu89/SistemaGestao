import { ApiError, type ErrorDetail } from '#shared/http/api_error'
import { isUuid } from '#shared/db/sql'
import { runInTenant, type TenantContext, type TenantScope } from '#modules/tenancy/index'
import { audit } from '#modules/audit/index'
import { postAccountingEvent } from '#modules/accounting/index'
import { cents, normalizeFields } from '#modules/hr/domain/recruitment'
import { moneyText } from '#modules/hr/domain/compensation'
import { periodEnd } from '#modules/hr/domain/loans'
import {
  createObligations,
  entityAccess,
  findRun,
  payScopes,
  runFor,
} from '#modules/hr/application/payroll_service'
import { payslipPdf } from '#modules/hr/application/payslip_pdf'

/*
 * Pagamento, contabilização e recibos (7.9). Fechar um lote não é pagá-lo: o fecho cria as obrigações (líquido, IRT,
 * INSS, descontos a terceiros) e os pagamentos registam-se à parte (`hr.payroll.pay`), só de acréscimo e nunca acima do
 * que falta. A contabilização (`hr.payroll.manage`) envia ao motor da contabilidade um evento PAYROLL/SALARIES por lote
 * e moeda e um evento por pagamento (`<TIPO>_PAID`), cada um uma única vez. Os recibos em PDF só existem para lotes
 * fechados e só os vê quem processa salários na entidade legal ou o próprio colaborador.
 */

export const OBLIGATION_KINDS = ['NET_PAY', 'IRT', 'INSS', 'DEDUCTIONS'] as const
type ObligationKind = (typeof OBLIGATION_KINDS)[number]
const KIND_LABEL: Record<ObligationKind, string> = {
  NET_PAY: 'Líquido aos colaboradores',
  IRT: 'IRT retido',
  INSS: 'Segurança social (trabalhador e empresa)',
  DEDUCTIONS: 'Outros descontos a entregar',
}
const RUN_KIND_LABEL: Record<string, string> = {
  REGULAR: 'Processamento regular',
  EXTRA: 'Processamento extra',
  RETRO: 'Processamento retroactivo',
}
const MONTHS = [
  'janeiro',
  'fevereiro',
  'março',
  'abril',
  'maio',
  'junho',
  'julho',
  'agosto',
  'setembro',
  'outubro',
  'novembro',
  'dezembro',
]
const monthName = (p: string) => `${MONTHS[Number(p.slice(5, 7)) - 1]} de ${p.slice(0, 4)}`
const ptDate = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`
const today = () => new Date().toISOString().slice(0, 10)
const fail = (issues: ErrorDetail[]) => {
  if (issues.length) throw ApiError.validation(issues)
}

const paymentStatus = (amount: string, paid: string) => {
  const a = cents(amount) ?? 0n
  const p = cents(paid) ?? 0n
  return p === 0n ? 'UNPAID' : p >= a ? 'PAID' : 'PARTIAL'
}

async function obligationsOf(scope: TenantScope, runId: string) {
  const r = await scope.trx.rawQuery(
    `select o.*, o.due_date::text as due_text from payroll_obligations o
      where o.tenant_id = ? and o.run_id = ? order by o.currency,
        array_position(array['NET_PAY','IRT','INSS','DEDUCTIONS']::text[], o.kind::text)`,
    [scope.context.tenantId, runId]
  )
  const pays = await scope.trx.rawQuery(
    `select p.*, p.paid_on::text as paid_text, b.bank_name, pp.posting_event_id, u.full_name as created_by_name
       from payroll_obligation_payments p
       join payroll_obligations o on o.tenant_id = p.tenant_id and o.id = p.obligation_id
       left join bank_accounts b on b.tenant_id = p.tenant_id and b.id = p.bank_account_id
       left join payroll_postings pp on pp.tenant_id = p.tenant_id and pp.payment_id = p.id
       left join users u on u.id = p.created_by
      where p.tenant_id = ? and o.run_id = ? order by p.paid_on, p.sequence`,
    [scope.context.tenantId, runId]
  )
  return (r.rows as any[]).map((o) => ({
    id: o.id as string,
    version: Number(o.version),
    kind: o.kind as ObligationKind,
    label: KIND_LABEL[o.kind as ObligationKind],
    currency: o.currency as string,
    amount: o.amount as string,
    paidAmount: o.paid_amount as string,
    outstanding: moneyText((cents(o.amount) ?? 0n) - (cents(o.paid_amount) ?? 0n)),
    status: paymentStatus(o.amount, o.paid_amount),
    dueDate: (o.due_text as string) ?? null,
    payments: (pays.rows as any[])
      .filter((p) => p.obligation_id === o.id)
      .map((p) => ({
        id: p.id as string,
        sequence: Number(p.sequence),
        amount: p.amount as string,
        paidOn: p.paid_text as string,
        reference: p.reference as string,
        bankName: (p.bank_name as string) ?? null,
        note: (p.note as string) ?? null,
        accounted: Boolean(p.posting_event_id),
        createdBy: (p.created_by_name as string) ?? null,
      })),
  }))
}

/** Montantes do lote por moeda para o evento de contabilização (todos com 2 casas). */
async function runAmounts(scope: TenantScope, runId: string) {
  const r = await scope.trx.rawQuery(
    `select currency, sum(gross)::text as gross, sum(inss_employee)::text as inss_employee, sum(irt)::text as irt,
        sum(deductions)::text as deductions, sum(loans)::text as loans, sum(net)::text as net,
        sum(inss_employer)::text as inss_employer, sum(employer_cost)::text as employer_cost
       from payroll_results where tenant_id = ? and run_id = ? and status = 'OK' group by currency order by currency`,
    [scope.context.tenantId, runId]
  )
  return (r.rows as any[]).map((x) => {
    const c = (v: string) => cents(v) ?? 0n
    const amounts = {
      gross: c(x.gross),
      inssEmployee: c(x.inss_employee),
      irt: c(x.irt),
      deductions: c(x.deductions),
      loans: c(x.loans),
      net: c(x.net),
      inssEmployer: c(x.inss_employer),
      inssTotal: c(x.inss_employee) + c(x.inss_employer),
      employerCost: c(x.employer_cost),
    }
    return { currency: x.currency as string, amounts }
  })
}

async function accountingOf(scope: TenantScope, runId: string) {
  const r = await scope.trx.rawQuery(
    `select pp.kind, pp.currency, pp.payment_id, e.status, e.event, j.number as entry_number, j.status as entry_status
       from payroll_postings pp
       join posting_events e on e.tenant_id = pp.tenant_id and e.id = pp.posting_event_id
       left join journal_entries j on j.tenant_id = e.tenant_id and j.id = e.entry_id
      where pp.tenant_id = ? and pp.run_id = ? order by pp.created_at`,
    [scope.context.tenantId, runId]
  )
  return (r.rows as any[]).map((x) => ({
    kind: x.kind as 'ACCRUAL' | 'PAYMENT',
    currency: x.currency as string,
    paymentId: (x.payment_id as string) ?? null,
    event: x.event as string,
    status: x.status as string,
    entryNumber: (x.entry_number as string) ?? null,
    entryStatus: (x.entry_status as string) ?? null,
  }))
}

const needPay = (access: { pay: boolean }) => {
  if (!access.pay)
    throw ApiError.forbidden(
      'OUT_OF_SCOPE',
      'Não regista pagamentos de salários desta entidade legal.'
    )
}

/**
 * Obrigações de salários por pagar (contrato para Finanças/Tesouraria): lotes fechados com valor em dívida, por
 * entidade legal. Lido na transacção de quem chama; não verifica permissões (quem chama decide).
 */
export async function payrollObligations(
  scope: TenantScope,
  f: { legalEntityId?: string; onlyOutstanding?: boolean } = {}
) {
  const r = await scope.trx.rawQuery(
    `select o.id, o.kind, o.currency, o.amount, o.paid_amount, o.due_date::text as due_text, u.id as run_id,
        u.code as run_code, per.period::text as period_text, per.legal_entity_id
       from payroll_obligations o
       join payroll_runs u on u.tenant_id = o.tenant_id and u.id = o.run_id
       join payroll_periods per on per.tenant_id = u.tenant_id and per.id = u.period_id
      where o.tenant_id = ?${f.legalEntityId ? ' and per.legal_entity_id = ?' : ''}
        ${f.onlyOutstanding ? 'and o.paid_amount < o.amount' : ''}
      order by per.period, u.code, o.kind`,
    [scope.context.tenantId, ...(f.legalEntityId ? [f.legalEntityId] : [])]
  )
  return (r.rows as any[]).map((o) => ({
    id: o.id as string,
    kind: o.kind as ObligationKind,
    currency: o.currency as string,
    amount: o.amount as string,
    paidAmount: o.paid_amount as string,
    dueDate: (o.due_text as string) ?? null,
    runId: o.run_id as string,
    runCode: o.run_code as string,
    period: o.period_text as string,
    legalEntityId: o.legal_entity_id as string,
  }))
}

export class PayrollPaymentService {
  /** Obrigações, pagamentos e estado da contabilização de um lote. */
  summary(context: TenantContext, runId: string) {
    return runInTenant(context, async (scope) => {
      const { u, access } = await runFor(scope, runId)
      if (u.status === 'CLOSED') await createObligations(scope, runId) // lotes fechados antes do 7.9
      const obligations = await obligationsOf(scope, runId)
      const net = obligations.filter((o) => o.kind === 'NET_PAY')
      const accounting = await accountingOf(scope, runId)
      const payments = obligations.flatMap((o) => o.payments)
      return {
        runId,
        closed: u.status === 'CLOSED',
        // Fechado ≠ pago: o estado do pagamento vem dos pagamentos do líquido.
        paymentStatus: !net.length
          ? 'NONE'
          : net.every((o) => o.status === 'PAID')
            ? 'PAID'
            : net.some((o) => o.status !== 'UNPAID')
              ? 'PARTIAL'
              : 'UNPAID',
        obligations,
        accounting: {
          accrued: accounting.filter((a) => a.kind === 'ACCRUAL'),
          paymentsAccounted: payments.filter((p) => p.accounted).length,
          paymentsTotal: payments.length,
        },
        access: {
          pay: u.status === 'CLOSED' && access.pay,
          account: u.status === 'CLOSED' && access.manage,
        },
      }
    })
  }

  /** Regista um pagamento de uma obrigação (parcial ou total). */
  pay(
    context: TenantContext,
    obligationId: string,
    input: Record<string, unknown>,
    expectedVersion: number
  ) {
    return runInTenant(context, async (scope) => {
      if (!isUuid(obligationId)) throw ApiError.notFound()
      const o = (
        await scope.trx.rawQuery(
          `select * from payroll_obligations where tenant_id = ? and id = ? for update`,
          [context.tenantId, obligationId]
        )
      ).rows[0] as any
      if (!o) throw ApiError.notFound()
      const { u, access } = await runFor(scope, o.run_id)
      needPay(access)
      if (Number(o.version) !== expectedVersion) throw ApiError.versionConflict(Number(o.version))
      const { values: v, issues } = normalizeFields(input, {
        amount: { kind: 'money', label: 'Montante' },
        paidOn: { kind: 'date', label: 'Data' },
        reference: { kind: 'text', min: 1, max: 80, label: 'Referência' },
        bankAccountId: { kind: 'uuid', label: 'Conta bancária' },
        note: { kind: 'longtext', max: 1000, label: 'Nota' },
      })
      for (const k of ['amount', 'paidOn', 'reference'])
        if (!v[k] && !issues.some((i) => i.path === k))
          issues.push({ path: k, code: 'REQUIRED', message: 'Obrigatório.' })
      const outstanding = (cents(o.amount) ?? 0n) - (cents(o.paid_amount) ?? 0n)
      const amount = v.amount ? (cents(v.amount) ?? 0n) : 0n
      if (v.amount && amount <= 0n)
        issues.push({
          path: 'amount',
          code: 'POSITIVE',
          message: 'O montante tem de ser positivo.',
        })
      if (amount > outstanding)
        issues.push({
          path: 'amount',
          code: 'OVERPAYMENT',
          message: `Só faltam ${moneyText(outstanding)} ${o.currency}.`,
        })
      if (v.paidOn && (v.paidOn as string) > today())
        issues.push({ path: 'paidOn', code: 'FUTURE', message: 'O pagamento não pode ser futuro.' })
      if (v.bankAccountId) {
        const b = (
          await scope.trx.rawQuery(
            `select legal_entity_id, currency, status from bank_accounts where tenant_id = ? and id = ?`,
            [context.tenantId, v.bankAccountId] as never[]
          )
        ).rows[0] as any
        if (!b || b.legal_entity_id !== u.legal_entity_id || b.status !== 'ACTIVE')
          issues.push({
            path: 'bankAccountId',
            code: 'INVALID',
            message: 'Conta bancária activa desta entidade legal.',
          })
        else if (String(b.currency).trim() !== o.currency)
          issues.push({
            path: 'bankAccountId',
            code: 'CURRENCY_MISMATCH',
            message: `A conta é em ${String(b.currency).trim()}.`,
          })
      }
      fail(issues)
      const seq = (
        await scope.trx.rawQuery(
          `select coalesce(max(sequence), 0) + 1 as n from payroll_obligation_payments
            where tenant_id = ? and obligation_id = ?`,
          [context.tenantId, obligationId]
        )
      ).rows[0] as { n: number }
      const r = await scope.trx.rawQuery(
        `insert into payroll_obligation_payments (tenant_id, obligation_id, sequence, amount, paid_on, reference,
           bank_account_id, note, created_by, updated_by) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) returning id`,
        [
          context.tenantId,
          obligationId,
          seq.n,
          v.amount,
          v.paidOn,
          v.reference,
          v.bankAccountId ?? null,
          v.note ?? null,
          context.userId,
          context.userId,
        ] as never[]
      )
      await scope.trx.rawQuery(
        `update payroll_obligations set paid_amount = paid_amount + ?::numeric, version = version + 1,
           updated_by = ?, updated_at = now() where tenant_id = ? and id = ?`,
        [v.amount, context.userId, context.tenantId, obligationId] as never[]
      )
      await audit(scope, {
        action: 'hr.payroll.obligation_paid',
        entityType: 'payroll_run',
        entityId: u.id,
        metadata: {
          code: u.code,
          obligation: o.kind,
          currency: o.currency,
          amount: v.amount,
          paidOn: v.paidOn,
          reference: v.reference,
          paymentId: (r.rows[0] as { id: string }).id,
        },
      })
      return { id: (r.rows[0] as { id: string }).id }
    })
  }

  /**
   * Envia à contabilidade o que falta: o processamento (PAYROLL/SALARIES por moeda, com bruto, INSS, IRT, descontos,
   * empréstimos, líquido, INSS patronal e custo) e cada pagamento (PAYROLL/<TIPO>_PAID). Cada evento uma só vez (chave
   * idempotente do motor + registo aqui); as regras e contas são as que a empresa configurou na contabilidade.
   */
  account(context: TenantContext, runId: string) {
    return runInTenant(context, async (scope) => {
      const { u, access } = await runFor(scope, runId, true)
      if (!access.manage)
        throw ApiError.forbidden('OUT_OF_SCOPE', 'Não gere o processamento desta entidade legal.')
      if (u.status !== 'CLOSED')
        throw ApiError.conflict('INVALID_STATE', 'Só um lote fechado se contabiliza.')
      await createObligations(scope, runId)
      const done = await accountingOf(scope, runId)
      const occurredOn = periodEnd(u.period_text)
      const groups = await runAmounts(scope, runId)
      let posted = 0
      for (const g of groups) {
        if (done.some((d) => d.kind === 'ACCRUAL' && d.currency === g.currency)) continue
        const negative = Object.entries(g.amounts).filter(([, value]) => value < 0n)
        if (negative.length)
          throw ApiError.conflict(
            'NEGATIVE_AMOUNTS',
            `O lote tem totais negativos (${negative.map(([k]) => k).join(', ')}): contabilize a correcção manualmente.`
          )
        const ref = groups.length > 1 ? `${u.code}:${g.currency}` : u.code
        const result = await postAccountingEvent(scope, {
          legalEntityId: u.legal_entity_id,
          source: 'PAYROLL',
          event: 'SALARIES',
          sourceRef: ref,
          occurredOn,
          currency: g.currency,
          amounts: Object.fromEntries(
            Object.entries(g.amounts).map(([k, val]) => [k, moneyText(val)])
          ),
          description: `Salários ${monthName(u.period_text)} (${u.code})`,
        })
        await scope.trx.rawQuery(
          `insert into payroll_postings (tenant_id, run_id, kind, currency, posting_event_id, created_by, updated_by)
           values (?, ?, 'ACCRUAL', ?, ?, ?, ?)`,
          [
            context.tenantId,
            runId,
            g.currency,
            (result.event as any).id,
            context.userId,
            context.userId,
          ]
        )
        posted++
      }
      const pending = await scope.trx.rawQuery(
        `select p.*, p.paid_on::text as paid_text, o.kind, o.currency from payroll_obligation_payments p
           join payroll_obligations o on o.tenant_id = p.tenant_id and o.id = p.obligation_id
          where p.tenant_id = ? and o.run_id = ?
            and not exists (select 1 from payroll_postings pp where pp.tenant_id = p.tenant_id and pp.payment_id = p.id)
          order by p.paid_on, p.created_at`,
        [context.tenantId, runId]
      )
      for (const p of pending.rows as any[]) {
        const result = await postAccountingEvent(scope, {
          legalEntityId: u.legal_entity_id,
          source: 'PAYROLL',
          event: `${p.kind}_PAID`,
          sourceRef: `${u.code}:${p.kind}:${p.sequence}`,
          occurredOn: p.paid_text,
          currency: p.currency,
          amounts: { amount: p.amount },
          description: `${KIND_LABEL[p.kind as ObligationKind]} — ${u.code} (${p.reference})`,
        })
        await scope.trx.rawQuery(
          `insert into payroll_postings (tenant_id, run_id, payment_id, kind, currency, posting_event_id, created_by,
             updated_by) values (?, ?, ?, 'PAYMENT', ?, ?, ?, ?)`,
          [
            context.tenantId,
            runId,
            p.id,
            p.currency,
            (result.event as any).id,
            context.userId,
            context.userId,
          ]
        )
        posted++
      }
      await audit(scope, {
        action: 'hr.payroll.accounted',
        entityType: 'payroll_run',
        entityId: runId,
        metadata: { code: u.code, events: posted },
      })
      return { posted }
    })
  }

  /** Recibos do próprio (lotes fechados), em qualquer entidade legal onde é colaborador. */
  mine(context: TenantContext) {
    return runInTenant(context, async (scope) => {
      const r = await scope.trx.rawQuery(
        `select p.id, p.currency, p.gross, p.net, u.code as run_code, u.kind, per.period::text as period_text,
            le.legal_name, e.code as employee_code,
            (select coalesce(bool_and(o.paid_amount >= o.amount), false) from payroll_obligations o
              where o.tenant_id = u.tenant_id and o.run_id = u.id and o.kind = 'NET_PAY') as paid
           from payroll_results p
           join payroll_runs u on u.tenant_id = p.tenant_id and u.id = p.run_id
           join payroll_periods per on per.tenant_id = u.tenant_id and per.id = u.period_id
           join legal_entities le on le.tenant_id = per.tenant_id and le.id = per.legal_entity_id
           join employees e on e.tenant_id = p.tenant_id and e.id = p.employee_id
          where p.tenant_id = ? and e.membership_id = ? and u.status = 'CLOSED' and p.status = 'OK'
          order by per.period desc, u.closed_at desc limit 120`,
        [context.tenantId, context.membershipId]
      )
      return (r.rows as any[]).map((x) => ({
        id: x.id as string,
        runCode: x.run_code as string,
        kind: x.kind as string,
        period: x.period_text as string,
        company: x.legal_name as string,
        currency: x.currency as string,
        gross: x.gross as string,
        net: x.net as string,
        paid: Boolean(x.paid),
      }))
    })
  }

  /** PDF de um recibo: lote fechado; quem processa salários na entidade legal ou o próprio colaborador. */
  payslip(context: TenantContext, resultId: string) {
    return runInTenant(context, async (scope) => {
      if (!isUuid(resultId)) throw ApiError.notFound()
      const p = (
        await scope.trx.rawQuery(
          `select p.*, e.code, e.full_name, e.tax_id, e.social_security_number, e.bank_iban, e.membership_id,
              pos.name as position_name
             from payroll_results p
             join employees e on e.tenant_id = p.tenant_id and e.id = p.employee_id
             left join positions pos on pos.tenant_id = e.tenant_id and pos.id = e.position_id
            where p.tenant_id = ? and p.id = ?`,
          [context.tenantId, resultId]
        )
      ).rows[0] as any
      if (!p) throw ApiError.notFound()
      const u = await findRun(scope, p.run_id)
      const own = !!p.membership_id && p.membership_id === context.membershipId
      const s = await payScopes(scope)
      if (!own && !entityAccess(s, u.legal_entity_id).read) throw ApiError.notFound()
      if (u.status !== 'CLOSED' || p.status !== 'OK')
        throw ApiError.conflict('NOT_CLOSED', 'O recibo só existe depois de fechado o lote.')
      await createObligations(scope, u.id)
      const le = (
        await scope.trx.rawQuery(
          `select legal_name, tax_id from legal_entities where tenant_id = ? and id = ?`,
          [context.tenantId, u.legal_entity_id]
        )
      ).rows[0] as any
      const lines = await scope.trx.rawQuery(
        `select name, kind, amount from payroll_result_lines where tenant_id = ? and result_id = ? order by sequence`,
        [context.tenantId, resultId]
      )
      const net = (await obligationsOf(scope, u.id)).find(
        (o) => o.kind === 'NET_PAY' && o.currency === p.currency
      )
      const lastPaid = net?.payments.length ? net.payments[net.payments.length - 1].paidOn : null
      const payment = !net
        ? 'sem valor a pagar'
        : net.status === 'PAID'
          ? `pago (${ptDate(lastPaid!)})`
          : net.status === 'PARTIAL'
            ? 'pago parcialmente'
            : 'por pagar'
      const rules = p.snapshot?.rules
      const buffer = payslipPdf({
        company: { legalName: le.legal_name, taxId: le.tax_id },
        employee: {
          code: p.code,
          fullName: p.full_name,
          taxId: p.tax_id ?? null,
          socialSecurityNumber: p.social_security_number ?? null,
          position: p.position_name ?? null,
          bankIban: p.bank_iban ?? null,
        },
        run: {
          code: u.code,
          kindLabel:
            u.kind === 'RETRO' && u.target_text
              ? `${RUN_KIND_LABEL.RETRO} de ${monthName(u.target_text)}`
              : RUN_KIND_LABEL[u.kind],
          periodLabel: monthName(u.period_text),
          closedAt: u.closed_at ? ptDate(new Date(u.closed_at).toISOString().slice(0, 10)) : null,
        },
        currency: p.currency,
        lines: (lines.rows as any[]).map((l) => ({ name: l.name, kind: l.kind, amount: l.amount })),
        totals: { gross: p.gross, net: p.net, employerCost: p.employer_cost },
        bases: { inss: p.inss_base ?? null, irt: p.irt_base ?? null },
        payment,
        rules: rules ? `${rules.code} (${rules.legalReference})` : null,
        generatedAt: ptDate(today()),
      })
      await audit(scope, {
        action: 'hr.payroll.payslip_downloaded',
        entityType: 'payroll_run',
        entityId: u.id,
        metadata: { employeeId: p.employee_id, own },
      })
      return {
        buffer,
        fileName: `recibo-${u.period_text.slice(0, 7)}-${p.code}-${u.code}.pdf`,
      }
    })
  }
}
