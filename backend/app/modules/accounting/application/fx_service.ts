import { ApiError, type ErrorDetail } from '#shared/http/api_error'
import { runInTenant, type TenantContext, type TenantScope } from '#modules/tenancy/index'
import { audit } from '#modules/audit/index'
import { legalEntityFacts } from '#modules/organization/index'
import { rateOn, tenantSettings } from '#modules/settings/index'
import { createEntryInScope } from '#modules/accounting/application/entries_service'
import {
  accountIssues,
  entryFacts,
  ISO,
  journalIssue,
  text,
  UUID,
} from '#modules/accounting/application/references'
import { type FxBalance, revalue } from '#modules/accounting/domain/adjustments'
import { RATE_SCALE } from '#modules/accounting/domain/accounting'
import { formatDecimal, parseDecimal } from '#modules/accounting/domain/decimal'

/**
 * Diferenças cambiais (6.7). Para as contas escolhidas, agrupa os saldos contabilizados por conta, moeda e terceiro:
 * saldo em moeda estrangeira × câmbio de fecho = novo saldo funcional (diferença não realizada); saldo em moeda já
 * liquidado mas com resíduo funcional = diferença realizada. O resultado é um rascunho em moeda funcional que segue
 * a aprovação; as diferenças ficam registadas por saldo para a actualização seguinte partir do valor já actualizado.
 */
export interface RevaluationInput {
  legalEntityId: string
  date: string
  accountIds: string[]
  journalId?: string
  unrealizedGainAccountId?: string
  unrealizedLossAccountId?: string
  realizedGainAccountId?: string
  realizedLossAccountId?: string
}

async function entity(scope: TenantScope, legalEntityId: string) {
  const le = UUID.test(legalEntityId) ? await legalEntityFacts(scope, legalEntityId) : null
  if (UUID.test(legalEntityId) && !le) throw ApiError.notFound()
  return le
}

async function compute(scope: TenantScope, input: RevaluationInput) {
  const issues: ErrorDetail[] = []
  const le = await entity(scope, input.legalEntityId)
  if (!le) issues.push({ path: 'legalEntityId', code: 'INVALID', message: 'Entidade legal.' })
  if (!ISO.test(input.date))
    issues.push({ path: 'date', code: 'REQUIRED', message: 'Data (AAAA-MM-DD).' })
  const ids = [...new Set(input.accountIds.map(text))]
  if (ids.length === 0 || ids.length > 200 || ids.some((x) => !UUID.test(x)))
    issues.push({
      path: 'accountIds',
      code: 'REQUIRED',
      message: 'Escolha as contas a actualizar (1 a 200).',
    })
  if (issues.length) throw ApiError.validation(issues)
  const { amountScale: scale, roundingMode } = await tenantSettings(scope)
  const t = scope.context.tenantId
  const base = await scope.trx.rawQuery(
    `select l.account_id, e.currency, l.third_party_ref,
            round(sum(l.debit - l.credit), ?::int)::text as foreign,
            round(sum(l.debit_functional - l.credit_functional), ?::int)::text as functional
       from journal_lines l join journal_entries e on e.tenant_id = l.tenant_id and e.id = l.entry_id
      where l.tenant_id = ? and e.legal_entity_id = ? and e.status = 'POSTED' and e.entry_date <= ?
        and e.currency <> ? and l.account_id = any(?::uuid[])
      group by l.account_id, e.currency, l.third_party_ref`,
    [scale, scale, t, input.legalEntityId, input.date, le!.functionalCurrency, ids]
  )
  // Actualizações anteriores já contabilizadas (e não estornadas) contam para o saldo funcional.
  const prior = await scope.trx.rawQuery(
    `select rl.account_id, rl.currency, rl.third_party_ref, round(sum(rl.difference), ?::int)::text as adj
       from fx_revaluation_lines rl
       join fx_revaluations r on r.tenant_id = rl.tenant_id and r.id = rl.revaluation_id
       join journal_entries e on e.tenant_id = r.tenant_id and e.id = r.entry_id
      where rl.tenant_id = ? and r.legal_entity_id = ? and r.revaluation_date <= ? and e.status = 'POSTED'
        and e.reversed_by_id is null and rl.account_id = any(?::uuid[])
      group by rl.account_id, rl.currency, rl.third_party_ref`,
    [scale, t, input.legalEntityId, input.date, ids]
  )
  const toInt = (v: string) => {
    const neg = v.startsWith('-')
    const x = parseDecimal(neg ? v.slice(1) : v, scale)!
    return neg ? -x : x
  }
  const key = (a: string, c: string, tp: string | null) => `${a}|${c}|${tp ?? ''}`
  const adj = new Map(
    (
      prior.rows as {
        account_id: string
        currency: string
        third_party_ref: string | null
        adj: string
      }[]
    ).map((r) => [key(r.account_id, r.currency, r.third_party_ref), toInt(r.adj)])
  )
  const balances: FxBalance[] = (
    base.rows as {
      account_id: string
      currency: string
      third_party_ref: string | null
      foreign: string
      functional: string
    }[]
  ).map((r) => ({
    accountId: r.account_id,
    currency: r.currency,
    thirdPartyRef: r.third_party_ref,
    foreign: toInt(r.foreign),
    functional:
      toInt(r.functional) + (adj.get(key(r.account_id, r.currency, r.third_party_ref)) ?? 0n),
  }))
  const rates = new Map<string, bigint>()
  for (const currency of new Set(balances.filter((b) => b.foreign !== 0n).map((b) => b.currency))) {
    const found = await rateOn(scope, currency, le!.functionalCurrency, input.date)
    const value = found ? parseDecimal(found.rate, RATE_SCALE) : null
    if (value) rates.set(currency, value)
  }
  const out = revalue(balances, rates, scale, RATE_SCALE, roundingMode)
  const codes = await scope.trx.rawQuery(
    'select id, code, name from accounts where tenant_id = ? and id = any(?::uuid[])',
    [t, ids]
  )
  const names = new Map(
    (codes.rows as { id: string; code: string; name: string }[]).map((a) => [a.id, a])
  )
  return { le: le!, scale, ...out, names }
}

function view(c: Awaited<ReturnType<typeof compute>>) {
  const m = (v: bigint) => formatDecimal(v, c.scale)
  return {
    functionalCurrency: c.le.functionalCurrency,
    missingRates: c.missingRates,
    lines: c.results.map((r) => ({
      kind: r.kind,
      accountId: r.accountId,
      accountCode: c.names.get(r.accountId)?.code ?? null,
      accountName: c.names.get(r.accountId)?.name ?? null,
      currency: r.currency,
      thirdPartyRef: r.thirdPartyRef,
      foreignBalance: m(r.foreign),
      functionalBefore: m(r.functional),
      rate: r.rate === null ? null : formatDecimal(r.rate, RATE_SCALE),
      functionalAfter: m(r.functionalAfter),
      difference: m(r.difference),
    })),
    gains: m(c.results.filter((r) => r.difference > 0n).reduce((a, r) => a + r.difference, 0n)),
    losses: m(-c.results.filter((r) => r.difference < 0n).reduce((a, r) => a + r.difference, 0n)),
  }
}

async function pending(scope: TenantScope, legalEntityId: string) {
  const r = await scope.trx.rawQuery(
    `select r.revaluation_date::text as date from fx_revaluations r
       join journal_entries e on e.tenant_id = r.tenant_id and e.id = r.entry_id
      where r.tenant_id = ? and r.legal_entity_id = ? and e.status <> 'POSTED' limit 1`,
    [scope.context.tenantId, legalEntityId]
  )
  return (r.rows[0] as { date: string } | undefined)?.date ?? null
}

export class FxRevaluationService {
  list(context: TenantContext, legalEntityId: string | undefined) {
    return runInTenant(context, async (scope) => {
      const scale = (await tenantSettings(scope)).amountScale
      const r = await scope.trx.rawQuery(
        `select r.id, r.legal_entity_id as "legalEntityId", r.revaluation_date::text as date, r.entry_id as "entryId",
                count(l.id)::int as lines,
                round(coalesce(sum(greatest(l.difference, 0)), 0), ?::int)::text as gains,
                round(coalesce(sum(greatest(-l.difference, 0)), 0), ?::int)::text as losses
           from fx_revaluations r left join fx_revaluation_lines l on l.tenant_id = r.tenant_id and l.revaluation_id = r.id
          where r.tenant_id = ? ${legalEntityId ? 'and r.legal_entity_id = ?' : ''}
          group by r.id order by r.revaluation_date desc limit 200`,
        [scale, scale, context.tenantId, ...(legalEntityId ? [legalEntityId] : [])]
      )
      const rows = r.rows as { entryId: string }[]
      const facts = await entryFacts(
        scope,
        rows.map((x) => x.entryId)
      )
      return rows.map((x) => ({
        ...x,
        entryNumber: facts.get(x.entryId)?.number ?? null,
        entryStatus: facts.get(x.entryId)?.status ?? null,
        reversed: facts.get(x.entryId)?.reversed ?? false,
      }))
    })
  }

  /** Simulação: diferenças por saldo, câmbios em falta e se há outra actualização por contabilizar. */
  preview(context: TenantContext, input: RevaluationInput) {
    return runInTenant(context, async (scope) => {
      const c = await compute(scope, input)
      return { ...view(c), pendingRevaluation: await pending(scope, input.legalEntityId) }
    })
  }

  /**
   * Gera o rascunho da actualização: uma linha por saldo (débito se o saldo devedor aumenta, crédito se diminui) e as
   * contrapartidas agregadas em ganhos/perdas realizados ou não realizados. Uma por entidade e data, e nunca com
   * outra ainda por contabilizar (contaria duas vezes a mesma diferença).
   */
  run(context: TenantContext, input: RevaluationInput) {
    return runInTenant(context, async (scope) => {
      await entity(scope, input.legalEntityId)
      await scope.trx.rawQuery('select pg_advisory_xact_lock(hashtext(?))', [
        `${context.tenantId}:fx:${input.legalEntityId}`,
      ])
      const issues: ErrorDetail[] = []
      if (UUID.test(input.legalEntityId)) {
        const j = await journalIssue(scope, input.legalEntityId, input.journalId)
        if (j) issues.push(j)
        const keys = [
          'unrealizedGainAccountId',
          'unrealizedLossAccountId',
          'realizedGainAccountId',
          'realizedLossAccountId',
        ] as const
        issues.push(
          ...(await accountIssues(
            scope,
            input.legalEntityId,
            keys.map((k) => input[k]),
            [...keys]
          ))
        )
      }
      if (issues.length) throw ApiError.validation(issues)
      const c = await compute(scope, input)
      const waiting = await pending(scope, input.legalEntityId)
      if (waiting)
        throw ApiError.conflict(
          'PENDING_REVALUATION',
          `A actualização de ${waiting} ainda não está contabilizada: contabilize-a ou apague o rascunho.`
        )
      if (c.missingRates.length)
        throw ApiError.validation([
          {
            path: 'date',
            code: 'MISSING_RATE',
            message: `Sem câmbio para ${c.missingRates.join(', ')}→${c.le.functionalCurrency} em ${input.date}.`,
          },
        ])
      if (c.results.length === 0)
        throw ApiError.conflict('NOTHING_TO_REVALUE', 'Não há diferenças cambiais nesta data.')
      const exists = await scope.trx.rawQuery(
        'select 1 from fx_revaluations where tenant_id = ? and legal_entity_id = ? and revaluation_date = ?',
        [context.tenantId, input.legalEntityId, input.date]
      )
      if (exists.rows.length)
        throw ApiError.conflict(
          'ALREADY_REVALUED',
          `Já há uma actualização cambial em ${input.date}.`
        )
      const m = (v: bigint) => formatDecimal(v, c.scale)
      const counter = new Map<string, bigint>()
      const lines: Record<string, unknown>[] = []
      for (const r of c.results) {
        const abs = r.difference > 0n ? r.difference : -r.difference
        const label = `${r.kind === 'REALIZED' ? 'Diferença realizada' : 'Actualização'} ${r.currency}`
        lines.push({
          accountId: r.accountId,
          debit: r.difference > 0n ? m(abs) : null,
          credit: r.difference < 0n ? m(abs) : null,
          thirdPartyRef: r.thirdPartyRef,
          description: label,
        })
        const target =
          r.kind === 'REALIZED'
            ? r.difference > 0n
              ? input.realizedGainAccountId!
              : input.realizedLossAccountId!
            : r.difference > 0n
              ? input.unrealizedGainAccountId!
              : input.unrealizedLossAccountId!
        // Ganho: crédito (valor negativo no mapa); perda: débito.
        counter.set(target, (counter.get(target) ?? 0n) - r.difference)
      }
      for (const [accountId, v] of counter)
        if (v !== 0n)
          lines.push({
            accountId,
            debit: v > 0n ? m(v) : null,
            credit: v < 0n ? m(-v) : null,
            description: v > 0n ? 'Perdas cambiais' : 'Ganhos cambiais',
          })
      const { entry } = await createEntryInScope(
        scope,
        {
          legalEntityId: input.legalEntityId,
          journalId: input.journalId,
          entryDate: input.date,
          reference: `FX ${input.date}`,
          description: `Diferenças cambiais em ${input.date}`,
          sourceRef: `FX:${input.date}`,
          lines,
        },
        'FX_REVALUATION'
      )
      const r = await scope.trx.rawQuery(
        `insert into fx_revaluations (tenant_id, created_by, updated_by, legal_entity_id, revaluation_date, entry_id)
         values (?, ?, ?, ?, ?, ?) returning id`,
        [
          context.tenantId,
          context.userId,
          context.userId,
          input.legalEntityId,
          input.date,
          entry.id,
        ]
      )
      const revaluationId = (r.rows[0] as { id: string }).id
      for (const x of c.results)
        await scope.trx.rawQuery(
          `insert into fx_revaluation_lines (tenant_id, created_by, updated_by, revaluation_id, kind, account_id, currency,
             third_party_ref, foreign_balance, functional_before, rate, functional_after, difference)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            context.tenantId,
            context.userId,
            context.userId,
            revaluationId,
            x.kind,
            x.accountId,
            x.currency,
            x.thirdPartyRef,
            m(x.foreign),
            m(x.functional),
            x.rate === null ? null : formatDecimal(x.rate, RATE_SCALE),
            m(x.functionalAfter),
            m(x.difference),
          ] as never[]
        )
      await audit(scope, {
        action: 'fx_revaluation.created',
        entityType: 'fx_revaluation',
        entityId: revaluationId,
        metadata: { date: input.date, entryId: entry.id, balances: c.results.length },
      })
      return { id: revaluationId, entryId: entry.id, ...view(c) }
    })
  }
}
