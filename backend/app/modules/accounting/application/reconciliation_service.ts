import { ApiError, type ErrorDetail } from '#shared/http/api_error'
import { constraintOf } from '#shared/db/sql'
import { runInTenant, type TenantContext, type TenantScope } from '#modules/tenancy/index'
import { audit } from '#modules/audit/index'
import { tenantSettings } from '#modules/settings/index'
import { legalEntityExists, optional, text, UUID } from '#modules/accounting/application/references'
import { formatDecimal, parseDecimal } from '#modules/accounting/domain/decimal'

/**
 * Reconciliação de contas (6.7): emparelhar linhas contabilizadas de uma conta (e terceiro) cujos débitos e
 * créditos se anulam — p. ex. a factura do fornecedor com o seu pagamento. Cada linha do razão só entra numa
 * reconciliação (restrição única); desfazer apaga o grupo (auditado) e as linhas voltam a estar em aberto.
 */
const MAX_OPEN = 1000

async function scaleOf(scope: TenantScope) {
  return (await tenantSettings(scope)).amountScale
}

function signed(v: string, scale: number) {
  const neg = v.startsWith('-')
  const x = parseDecimal(neg ? v.slice(1) : v, scale)!
  return neg ? -x : x
}

async function assertScope(scope: TenantScope, legalEntityId: string, accountId: string) {
  const issues: ErrorDetail[] = []
  if (!UUID.test(legalEntityId))
    issues.push({ path: 'legalEntityId', code: 'INVALID', message: 'Entidade legal.' })
  if (!UUID.test(accountId)) issues.push({ path: 'accountId', code: 'INVALID', message: 'Conta.' })
  if (issues.length) throw ApiError.validation(issues)
  if (!(await legalEntityExists(scope, legalEntityId))) throw ApiError.notFound()
  const r = await scope.trx.rawQuery(
    `select 1 from accounts a join account_charts c on c.tenant_id = a.tenant_id and c.id = a.chart_id
      where a.tenant_id = ? and a.id = ? and c.legal_entity_id = ?`,
    [scope.context.tenantId, accountId, legalEntityId]
  )
  if (r.rows.length === 0) throw ApiError.notFound()
}

export class ReconciliationService {
  /** Linhas contabilizadas da conta (e terceiro) ainda não reconciliadas, com o saldo em aberto. */
  openItems(
    context: TenantContext,
    q: { legalEntityId: string; accountId: string; thirdPartyRef?: string | null }
  ) {
    return runInTenant(context, async (scope) => {
      await assertScope(scope, q.legalEntityId, q.accountId)
      const scale = await scaleOf(scope)
      const third = text(q.thirdPartyRef)
      const r = await scope.trx.rawQuery(
        `select l.entry_id as "entryId", l.line_no as "lineNo", e.entry_date::text as date, e.number,
                coalesce(l.description, e.description) as description, l.third_party_ref as "thirdPartyRef",
                round(l.debit_functional, ?::int)::text as debit, round(l.credit_functional, ?::int)::text as credit
           from journal_lines l join journal_entries e on e.tenant_id = l.tenant_id and e.id = l.entry_id
          where l.tenant_id = ? and e.legal_entity_id = ? and l.account_id = ? and e.status = 'POSTED'
            ${third ? 'and l.third_party_ref = ?' : ''}
            and not exists (select 1 from account_reconciliation_lines x
                             where x.tenant_id = l.tenant_id and x.entry_id = l.entry_id and x.line_no = l.line_no)
          order by e.entry_date, e.number, l.line_no limit ?`,
        [
          scale,
          scale,
          context.tenantId,
          q.legalEntityId,
          q.accountId,
          ...(third ? [third] : []),
          MAX_OPEN + 1,
        ]
      )
      const rows = r.rows as { debit: string; credit: string }[]
      const items = rows.slice(0, MAX_OPEN)
      const sum = (k: 'debit' | 'credit') => items.reduce((a, x) => a + signed(x[k], scale), 0n)
      const fmt = (v: bigint) => formatDecimal(v, scale)
      return {
        items,
        truncated: rows.length > MAX_OPEN,
        debit: fmt(sum('debit')),
        credit: fmt(sum('credit')),
        balance: fmt(sum('debit') - sum('credit')),
      }
    })
  }

  list(context: TenantContext, q: { legalEntityId: string; accountId: string }) {
    return runInTenant(context, async (scope) => {
      await assertScope(scope, q.legalEntityId, q.accountId)
      const scale = await scaleOf(scope)
      const r = await scope.trx.rawQuery(
        `select r.id, r.third_party_ref as "thirdPartyRef", round(r.total, ?::int)::text as total, r.note,
                r.created_at as "createdAt", r.created_by as "createdBy",
                json_agg(json_build_object('entryId', x.entry_id, 'lineNo', x.line_no, 'number', e.number,
                  'date', e.entry_date) order by e.entry_date, x.line_no) as lines
           from account_reconciliations r
           join account_reconciliation_lines x on x.tenant_id = r.tenant_id and x.reconciliation_id = r.id
           join journal_entries e on e.tenant_id = x.tenant_id and e.id = x.entry_id
          where r.tenant_id = ? and r.legal_entity_id = ? and r.account_id = ?
          group by r.id order by r.created_at desc limit 200`,
        [scale, context.tenantId, q.legalEntityId, q.accountId]
      )
      return r.rows
    })
  }

  /**
   * Reconcilia 2 a 500 linhas contabilizadas da mesma conta, entidade e terceiro cujos débitos igualam os créditos
   * (moeda funcional). As linhas ficam bloqueadas durante a operação; a restrição única impede usá-las duas vezes.
   */
  reconcile(context: TenantContext, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const legalEntityId = text(input.legalEntityId)
      const accountId = text(input.accountId)
      await assertScope(scope, legalEntityId, accountId)
      const raw = Array.isArray(input.lines) ? input.lines : []
      const refs = raw.map((l: any) => ({ entryId: text(l?.entryId), lineNo: Number(l?.lineNo) }))
      if (
        refs.length < 2 ||
        refs.length > 500 ||
        refs.some((x) => !UUID.test(x.entryId) || !Number.isInteger(x.lineNo) || x.lineNo < 1)
      )
        throw ApiError.validation([
          { path: 'lines', code: 'MIN_LINES', message: 'Escolha entre 2 e 500 linhas.' },
        ])
      const keys = new Set(refs.map((x) => `${x.entryId}|${x.lineNo}`))
      if (keys.size !== refs.length)
        throw ApiError.validation([
          { path: 'lines', code: 'DUPLICATE', message: 'Linha repetida.' },
        ])
      const r = await scope.trx.rawQuery(
        `select l.entry_id, l.line_no, l.account_id, l.third_party_ref, e.legal_entity_id, e.status,
                l.debit_functional::text as debit, l.credit_functional::text as credit
           from journal_lines l join journal_entries e on e.tenant_id = l.tenant_id and e.id = l.entry_id
          where l.tenant_id = ? and (l.entry_id, l.line_no) in (${refs.map(() => '(?::uuid, ?::int)').join(', ')})
          for update of l`,
        [context.tenantId, ...refs.flatMap((x) => [x.entryId, x.lineNo])] as never[]
      )
      const rows = r.rows as {
        entry_id: string
        line_no: number
        account_id: string
        third_party_ref: string | null
        legal_entity_id: string
        status: string
        debit: string
        credit: string
      }[]
      const issues: ErrorDetail[] = []
      if (rows.length !== refs.length)
        issues.push({ path: 'lines', code: 'NOT_FOUND', message: 'Há linhas que não existem.' })
      if (rows.some((x) => x.status !== 'POSTED'))
        issues.push({
          path: 'lines',
          code: 'NOT_POSTED',
          message: 'Só linhas de lançamentos contabilizados.',
        })
      if (rows.some((x) => x.account_id !== accountId || x.legal_entity_id !== legalEntityId))
        issues.push({
          path: 'lines',
          code: 'OTHER_ACCOUNT',
          message: 'Todas as linhas têm de ser desta conta e entidade.',
        })
      const thirds = new Set(rows.map((x) => x.third_party_ref ?? ''))
      if (thirds.size > 1)
        issues.push({
          path: 'lines',
          code: 'THIRD_PARTY',
          message: 'As linhas têm de ser do mesmo terceiro.',
        })
      const debit = rows.reduce((a, x) => a + parseDecimal(x.debit, 6)!, 0n)
      const credit = rows.reduce((a, x) => a + parseDecimal(x.credit, 6)!, 0n)
      if (issues.length === 0 && debit !== credit)
        issues.push({
          path: 'lines',
          code: 'NOT_BALANCED',
          message: 'Os débitos e os créditos escolhidos têm de ser iguais.',
        })
      if (issues.length) throw ApiError.validation(issues)
      const already = await scope.trx.rawQuery(
        `select 1 from account_reconciliation_lines where tenant_id = ? and (entry_id, line_no) in (${refs
          .map(() => '(?::uuid, ?::int)')
          .join(', ')}) limit 1`,
        [context.tenantId, ...refs.flatMap((x) => [x.entryId, x.lineNo])] as never[]
      )
      if (already.rows.length)
        throw ApiError.conflict('ALREADY_RECONCILED', 'Há linhas já reconciliadas.')
      const g = await scope.trx.rawQuery(
        `insert into account_reconciliations (tenant_id, created_by, updated_by, legal_entity_id, account_id, third_party_ref, total, note)
         values (?, ?, ?, ?, ?, ?, ?, ?) returning id`,
        [
          context.tenantId,
          context.userId,
          context.userId,
          legalEntityId,
          accountId,
          [...thirds][0] || null,
          formatDecimal(debit, 6),
          optional(input.note, 300),
        ] as never[]
      )
      const id = (g.rows[0] as { id: string }).id
      try {
        await scope.trx.rawQuery('savepoint rec_lines')
        for (const x of refs)
          await scope.trx.rawQuery(
            `insert into account_reconciliation_lines (tenant_id, created_by, updated_by, reconciliation_id, entry_id, line_no)
             values (?, ?, ?, ?, ?, ?)`,
            [context.tenantId, context.userId, context.userId, id, x.entryId, x.lineNo]
          )
        await scope.trx.rawQuery('release savepoint rec_lines')
      } catch (error) {
        if (constraintOf(error) === 'account_reconciliation_lines_unique')
          throw ApiError.conflict('ALREADY_RECONCILED', 'Há linhas já reconciliadas.')
        throw error
      }
      await audit(scope, {
        action: 'account_reconciliation.created',
        entityType: 'account_reconciliation',
        entityId: id,
        metadata: { accountId, lines: refs.length },
      })
      return { id, lines: refs.length }
    })
  }

  undo(context: TenantContext, id: string) {
    return runInTenant(context, async (scope) => {
      const r = await scope.trx.rawQuery(
        `select r.id, r.account_id, json_agg(json_build_object('entryId', x.entry_id, 'lineNo', x.line_no)) as lines
           from account_reconciliations r
           join account_reconciliation_lines x on x.tenant_id = r.tenant_id and x.reconciliation_id = r.id
          where r.tenant_id = ? and r.id = ? group by r.id`,
        [context.tenantId, id]
      )
      const row = r.rows[0] as { id: string; account_id: string; lines: unknown } | undefined
      if (!row) throw ApiError.notFound()
      await scope.trx.rawQuery(
        'delete from account_reconciliations where tenant_id = ? and id = ?',
        [context.tenantId, id]
      )
      await audit(scope, {
        action: 'account_reconciliation.undone',
        entityType: 'account_reconciliation',
        entityId: id,
        metadata: { accountId: row.account_id, lines: row.lines },
      })
    })
  }
}
