import { ApiError } from '#core/http/api_error'
import { LucidTenantScope, type TenantScope } from '#core/tenancy/index'
import {
  type CampaignChannel,
  type CampaignStatus,
  type CampaignValues,
  type ConsentStatus,
  type ExclusionKind,
  type LeadStatus,
  type LeadValues,
  type MemberStatus,
  type OpportunityValues,
  type StageOutcome,
  type StageValues,
  type ActivityKind,
  type ActivityValues,
} from '#modules/prospecting/domain/prospecting'
import type {
  Activity,
  ActivityStore,
  Campaign,
  CampaignFilter,
  CampaignMember,
  CampaignStore,
  CampaignSummary,
  Exclusion,
  ExclusionStore,
  Lead,
  LeadFilter,
  LeadStore,
  Opportunity,
  OpportunityFilter,
  OpportunityMetrics,
  OpportunityStore,
  SendTarget,
  Stage,
  StageMove,
  StageStore,
} from '#modules/prospecting/application/ports'

const trxOf = (scope: TenantScope) => (scope as LucidTenantScope).trx
const tenantOf = (scope: TenantScope) => (scope as LucidTenantScope).context.tenantId
const actorOf = (scope: TenantScope) => (scope as LucidTenantScope).context.membershipId as never

const constraintOf = (error: unknown): string | undefined =>
  (error as { constraint?: string } | null)?.constraint

const escapeLike = (value: string) => value.replace(/[\\%_]/g, (c) => `\\${c}`)

const dateText = (value: unknown): string =>
  value instanceof Date ? value.toISOString().slice(0, 10) : String(value)

const iso = (value: unknown): string =>
  value instanceof Date ? value.toISOString() : String(value)

async function versioned(
  rows: { rows: unknown[] },
  current: () => Promise<{ version: number } | null>
): Promise<void> {
  if (rows.rows.length > 0) return
  const row = await current()
  if (!row) throw ApiError.notFound()
  throw ApiError.versionConflict(row.version)
}

// --- etapas -----------------------------------------------------------------------------------------

interface StageRow {
  id: string
  pipeline_code: string
  code: string
  name: string
  position: number
  probability: string
  terminal: boolean
  outcome: StageOutcome | null
  requires_evidence: boolean
  active: boolean
  version: number
  created_at: Date
  updated_at: Date
}

const STAGE_COLUMNS = `id, pipeline_code, code, name, position, probability, terminal, outcome, requires_evidence,
  active, version, created_at, updated_at`

const toStage = (r: StageRow): Stage => ({
  id: r.id,
  pipelineCode: r.pipeline_code,
  code: r.code,
  name: r.name,
  position: r.position,
  probability: r.probability,
  terminal: r.terminal,
  outcome: r.outcome,
  requiresEvidence: r.requires_evidence,
  active: r.active,
  version: r.version,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

export class LucidStageStore implements StageStore {
  async list(scope: TenantScope, pipelineCode: string, activeOnly: boolean) {
    const result = await trxOf(scope).rawQuery(
      `select ${STAGE_COLUMNS} from pipeline_stages
        where tenant_id = ? and pipeline_code = ? ${activeOnly ? 'and active' : ''}
        order by position, code`,
      [tenantOf(scope), pipelineCode] as never[]
    )
    return (result.rows as StageRow[]).map(toStage)
  }

  async find(scope: TenantScope, id: string) {
    const result = await trxOf(scope).rawQuery(
      `select ${STAGE_COLUMNS} from pipeline_stages where tenant_id = ? and id = ?`,
      [tenantOf(scope), id] as never[]
    )
    const [row] = result.rows as StageRow[]
    return row ? toStage(row) : null
  }

  async insertMissing(scope: TenantScope, values: readonly StageValues[]) {
    for (const v of values) {
      await trxOf(scope).rawQuery(
        `insert into pipeline_stages (tenant_id, pipeline_code, code, name, position, probability, terminal, outcome,
           requires_evidence, active, created_by_membership_id, updated_by_membership_id)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         on conflict (tenant_id, pipeline_code, code) do nothing`,
        [
          tenantOf(scope),
          v.pipelineCode,
          v.code,
          v.name,
          v.position,
          v.probability,
          v.terminal,
          v.outcome,
          v.requiresEvidence,
          v.active,
          actorOf(scope),
          actorOf(scope),
        ] as never[]
      )
    }
  }

  async insert(scope: TenantScope, v: StageValues) {
    try {
      const result = await trxOf(scope).rawQuery(
        `insert into pipeline_stages (tenant_id, pipeline_code, code, name, position, probability, terminal, outcome,
           requires_evidence, active, created_by_membership_id, updated_by_membership_id)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) returning ${STAGE_COLUMNS}`,
        [
          tenantOf(scope),
          v.pipelineCode,
          v.code,
          v.name,
          v.position,
          v.probability,
          v.terminal,
          v.outcome,
          v.requiresEvidence,
          v.active,
          actorOf(scope),
          actorOf(scope),
        ] as never[]
      )
      return toStage(result.rows[0] as StageRow)
    } catch (error) {
      if (constraintOf(error) === 'pipeline_stages_code_unique') return 'CODE' as const
      throw error
    }
  }

  async update(scope: TenantScope, id: string, expectedVersion: number, v: StageValues) {
    const result = await trxOf(scope).rawQuery(
      `update pipeline_stages
          set name = ?, position = ?, probability = ?, requires_evidence = ?, active = ?, updated_at = now(),
              updated_by_membership_id = ?, version = version + 1
        where tenant_id = ? and id = ? and version = ? returning ${STAGE_COLUMNS}`,
      [
        v.name,
        v.position,
        v.probability,
        v.requiresEvidence,
        v.active,
        actorOf(scope),
        tenantOf(scope),
        id,
        expectedVersion,
      ] as never[]
    )
    await versioned(result, () => this.find(scope, id))
    return toStage(result.rows[0] as StageRow)
  }

  async openCount(scope: TenantScope, stageId: string) {
    const result = await trxOf(scope).rawQuery(
      `select count(*)::int as n from opportunities where tenant_id = ? and stage_id = ?`,
      [tenantOf(scope), stageId] as never[]
    )
    return (result.rows[0] as { n: number }).n
  }
}

// --- leads ------------------------------------------------------------------------------------------

interface LeadRow {
  id: string
  name: string
  company_name: string | null
  email: string | null
  phone: string | null
  source: string
  owner_membership_id: string
  status: LeadStatus
  consent_status: ConsentStatus
  disqualify_reason: string | null
  party_id: string | null
  customer_id: string | null
  opportunity_id: string | null
  converted_at: Date | null
  version: number
  created_at: Date
  updated_at: Date
}

const LEAD_COLUMNS = `id, name, company_name, email, phone, source, owner_membership_id, status, consent_status,
  disqualify_reason, party_id, customer_id, opportunity_id, converted_at, version, created_at, updated_at`

const toLead = (r: LeadRow): Lead => ({
  id: r.id,
  name: r.name,
  companyName: r.company_name,
  email: r.email,
  phone: r.phone,
  source: r.source,
  ownerMembershipId: r.owner_membership_id,
  status: r.status,
  consentStatus: r.consent_status,
  disqualifyReason: r.disqualify_reason,
  partyId: r.party_id,
  customerId: r.customer_id,
  opportunityId: r.opportunity_id,
  convertedAt: r.converted_at,
  version: r.version,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

export class LucidLeadStore implements LeadStore {
  async list(scope: TenantScope, filter: LeadFilter) {
    const where = ['tenant_id = ?']
    const params: unknown[] = [tenantOf(scope)]
    if (filter.status) {
      where.push('status = ?')
      params.push(filter.status)
    }
    if (filter.ownerMembershipId) {
      where.push('owner_membership_id = ?')
      params.push(filter.ownerMembershipId)
    }
    if (filter.consentStatus) {
      where.push('consent_status = ?')
      params.push(filter.consentStatus)
    }
    if (filter.q) {
      const like = `%${escapeLike(filter.q)}%`
      where.push(`(name ilike ? or company_name ilike ? or email ilike ?)`)
      params.push(like, like, like)
    }
    const clause = where.join(' and ')
    const rows = await trxOf(scope).rawQuery(
      `select ${LEAD_COLUMNS} from leads where ${clause} order by created_at desc, id limit ? offset ?`,
      [...params, filter.limit, filter.offset] as never[]
    )
    const count = await trxOf(scope).rawQuery(
      `select count(*)::int as total from leads where ${clause}`,
      params as never[]
    )
    return {
      items: (rows.rows as LeadRow[]).map(toLead),
      total: (count.rows[0] as { total: number }).total,
    }
  }

  async find(scope: TenantScope, id: string, lock = false) {
    const result = await trxOf(scope).rawQuery(
      `select ${LEAD_COLUMNS} from leads where tenant_id = ? and id = ?${lock ? ' for update' : ''}`,
      [tenantOf(scope), id] as never[]
    )
    const [row] = result.rows as LeadRow[]
    return row ? toLead(row) : null
  }

  async insert(scope: TenantScope, v: LeadValues & { ownerMembershipId: string }) {
    const result = await trxOf(scope).rawQuery(
      `insert into leads (tenant_id, name, company_name, email, phone, source, owner_membership_id, consent_status,
         created_by_membership_id, updated_by_membership_id)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) returning ${LEAD_COLUMNS}`,
      [
        tenantOf(scope),
        v.name,
        v.companyName,
        v.email,
        v.phone,
        v.source,
        v.ownerMembershipId,
        v.consentStatus,
        actorOf(scope),
        actorOf(scope),
      ] as never[]
    )
    return toLead(result.rows[0] as LeadRow)
  }

  async update(
    scope: TenantScope,
    id: string,
    expectedVersion: number,
    v: LeadValues & { ownerMembershipId: string }
  ) {
    const result = await trxOf(scope).rawQuery(
      `update leads
          set name = ?, company_name = ?, email = ?, phone = ?, source = ?, owner_membership_id = ?,
              consent_status = ?, updated_at = now(), updated_by_membership_id = ?, version = version + 1
        where tenant_id = ? and id = ? and version = ? returning ${LEAD_COLUMNS}`,
      [
        v.name,
        v.companyName,
        v.email,
        v.phone,
        v.source,
        v.ownerMembershipId,
        v.consentStatus,
        actorOf(scope),
        tenantOf(scope),
        id,
        expectedVersion,
      ] as never[]
    )
    await versioned(result, () => this.find(scope, id))
    return toLead(result.rows[0] as LeadRow)
  }

  async setStatus(
    scope: TenantScope,
    id: string,
    patch: { status: 'QUALIFIED' } | { status: 'DISQUALIFIED'; reason: string } | { status: 'NEW' }
  ) {
    const result = await trxOf(scope).rawQuery(
      `update leads
          set status = ?, disqualify_reason = ?, updated_at = now(), updated_by_membership_id = ?, version = version + 1
        where tenant_id = ? and id = ? returning ${LEAD_COLUMNS}`,
      [
        patch.status,
        patch.status === 'DISQUALIFIED' ? patch.reason : null,
        actorOf(scope),
        tenantOf(scope),
        id,
      ] as never[]
    )
    return toLead(result.rows[0] as LeadRow)
  }

  async markConverted(
    scope: TenantScope,
    id: string,
    r: { partyId: string; customerId: string; opportunityId: string | null }
  ) {
    const result = await trxOf(scope).rawQuery(
      `update leads
          set status = 'CONVERTED', party_id = ?, customer_id = ?, opportunity_id = ?, converted_at = now(),
              disqualify_reason = null, updated_at = now(), updated_by_membership_id = ?, version = version + 1
        where tenant_id = ? and id = ? returning ${LEAD_COLUMNS}`,
      [r.partyId, r.customerId, r.opportunityId, actorOf(scope), tenantOf(scope), id] as never[]
    )
    return toLead(result.rows[0] as LeadRow)
  }
}

// --- oportunidades ----------------------------------------------------------------------------------

interface OpportunityRow {
  id: string
  organization_id: string
  customer_id: string | null
  lead_id: string | null
  name: string
  owner_membership_id: string
  stage_id: string
  stage_code: string
  stage_name: string
  probability: string
  outcome: StageOutcome | null
  expected_value: string
  currency: string
  expected_close_date: string | Date | null
  loss_reason: string | null
  win_evidence: string | null
  closed_at: Date | null
  customer_name: string | null
  lead_name: string | null
  version: number
  created_at: Date
  updated_at: Date
}

const OPPORTUNITY_SELECT = `
  select o.id, o.organization_id, o.customer_id, o.lead_id, o.name, o.owner_membership_id, o.stage_id,
         s.code as stage_code, s.name as stage_name, s.probability, s.outcome, o.expected_value, o.currency,
         o.expected_close_date, o.loss_reason, o.win_evidence, o.closed_at, cp.display_name as customer_name,
         l.name as lead_name, o.version, o.created_at, o.updated_at
    from opportunities o
    join pipeline_stages s on s.tenant_id = o.tenant_id and s.id = o.stage_id
    left join customers c on c.tenant_id = o.tenant_id and c.id = o.customer_id
    left join parties cp on cp.tenant_id = c.tenant_id and cp.id = c.party_id
    left join leads l on l.tenant_id = o.tenant_id and l.id = o.lead_id`

const toOpportunity = (r: OpportunityRow): Opportunity => ({
  id: r.id,
  organizationId: r.organization_id,
  customerId: r.customer_id,
  leadId: r.lead_id,
  name: r.name,
  ownerMembershipId: r.owner_membership_id,
  stageId: r.stage_id,
  stageCode: r.stage_code,
  stageName: r.stage_name,
  probability: r.probability,
  outcome: r.outcome,
  expectedValue: r.expected_value,
  currency: r.currency,
  expectedCloseDate: r.expected_close_date === null ? null : dateText(r.expected_close_date),
  lossReason: r.loss_reason,
  winEvidence: r.win_evidence,
  closedAt: r.closed_at,
  customerName: r.customer_name,
  leadName: r.lead_name,
  version: r.version,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

export class LucidOpportunityStore implements OpportunityStore {
  async list(scope: TenantScope, filter: OpportunityFilter) {
    const where = ['o.tenant_id = ?']
    const params: unknown[] = [tenantOf(scope)]
    const add = (clause: string, value: unknown) => {
      where.push(clause)
      params.push(value)
    }
    if (filter.stageId) add('o.stage_id = ?', filter.stageId)
    if (filter.ownerMembershipId) add('o.owner_membership_id = ?', filter.ownerMembershipId)
    if (filter.customerId) add('o.customer_id = ?', filter.customerId)
    if (filter.leadId) add('o.lead_id = ?', filter.leadId)
    if (filter.status === 'open') where.push('s.outcome is null')
    if (filter.status === 'won') where.push(`s.outcome = 'WON'`)
    if (filter.status === 'lost') where.push(`s.outcome = 'LOST'`)
    if (filter.q) add('o.name ilike ?', `%${escapeLike(filter.q)}%`)
    const clause = where.join(' and ')
    const rows = await trxOf(scope).rawQuery(
      `${OPPORTUNITY_SELECT} where ${clause} order by o.created_at desc, o.id limit ? offset ?`,
      [...params, filter.limit, filter.offset] as never[]
    )
    const count = await trxOf(scope).rawQuery(
      `select count(*)::int as total from opportunities o
         join pipeline_stages s on s.tenant_id = o.tenant_id and s.id = o.stage_id where ${clause}`,
      params as never[]
    )
    return {
      items: (rows.rows as OpportunityRow[]).map(toOpportunity),
      total: (count.rows[0] as { total: number }).total,
    }
  }

  async find(scope: TenantScope, id: string, lock = false) {
    if (lock) {
      await trxOf(scope).rawQuery(
        `select 1 from opportunities where tenant_id = ? and id = ? for update`,
        [tenantOf(scope), id] as never[]
      )
    }
    const result = await trxOf(scope).rawQuery(
      `${OPPORTUNITY_SELECT} where o.tenant_id = ? and o.id = ?`,
      [tenantOf(scope), id] as never[]
    )
    const [row] = result.rows as OpportunityRow[]
    return row ? toOpportunity(row) : null
  }

  async insert(
    scope: TenantScope,
    v: OpportunityValues & { stageId: string; ownerMembershipId: string }
  ) {
    const result = await trxOf(scope).rawQuery(
      `insert into opportunities (tenant_id, organization_id, customer_id, lead_id, name, owner_membership_id,
         stage_id, expected_value, currency, expected_close_date, created_by_membership_id, updated_by_membership_id)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) returning id`,
      [
        tenantOf(scope),
        v.organizationId,
        v.customerId,
        v.leadId,
        v.name,
        v.ownerMembershipId,
        v.stageId,
        v.expectedValue,
        v.currency,
        v.expectedCloseDate,
        actorOf(scope),
        actorOf(scope),
      ] as never[]
    )
    return (await this.find(scope, (result.rows[0] as { id: string }).id)) as Opportunity
  }

  async update(
    scope: TenantScope,
    id: string,
    expectedVersion: number,
    v: OpportunityValues & { stageId: string }
  ) {
    const result = await trxOf(scope).rawQuery(
      `update opportunities
          set name = ?, expected_value = ?, expected_close_date = ?, updated_at = now(),
              updated_by_membership_id = ?, version = version + 1
        where tenant_id = ? and id = ? and version = ? returning id`,
      [
        v.name,
        v.expectedValue,
        v.expectedCloseDate,
        actorOf(scope),
        tenantOf(scope),
        id,
        expectedVersion,
      ] as never[]
    )
    await versioned(result, () => this.find(scope, id))
    return (await this.find(scope, id)) as Opportunity
  }

  async moveTo(
    scope: TenantScope,
    id: string,
    patch: {
      stageId: string
      closed: boolean
      lossReason: string | null
      winEvidence: string | null
    }
  ) {
    await trxOf(scope).rawQuery(
      `update opportunities
          set stage_id = ?, closed_at = ${patch.closed ? 'now()' : 'null'}, loss_reason = ?, win_evidence = ?,
              updated_at = now(), updated_by_membership_id = ?, version = version + 1
        where tenant_id = ? and id = ?`,
      [
        patch.stageId,
        patch.lossReason,
        patch.winEvidence,
        actorOf(scope),
        tenantOf(scope),
        id,
      ] as never[]
    )
    return (await this.find(scope, id)) as Opportunity
  }

  async insertMove(
    scope: TenantScope,
    v: { opportunityId: string; fromStageId: string | null; toStageId: string }
  ) {
    await trxOf(scope).rawQuery(
      `insert into opportunity_stage_history (tenant_id, opportunity_id, from_stage_id, to_stage_id,
         created_by_membership_id, updated_by_membership_id)
       values (?, ?, ?, ?, ?, ?)`,
      [
        tenantOf(scope),
        v.opportunityId,
        v.fromStageId,
        v.toStageId,
        actorOf(scope),
        actorOf(scope),
      ] as never[]
    )
  }

  async history(scope: TenantScope, opportunityId: string): Promise<StageMove[]> {
    const result = await trxOf(scope).rawQuery(
      `select id, opportunity_id, from_stage_id, to_stage_id, moved_at, created_by_membership_id
         from opportunity_stage_history where tenant_id = ? and opportunity_id = ? order by moved_at, id`,
      [tenantOf(scope), opportunityId] as never[]
    )
    return (
      result.rows as {
        id: string
        opportunity_id: string
        from_stage_id: string | null
        to_stage_id: string
        moved_at: Date
        created_by_membership_id: string | null
      }[]
    ).map((r) => ({
      id: r.id,
      opportunityId: r.opportunity_id,
      fromStageId: r.from_stage_id,
      toStageId: r.to_stage_id,
      movedAt: r.moved_at,
      movedByMembershipId: r.created_by_membership_id,
    }))
  }

  async metrics(scope: TenantScope, from: string, to: string): Promise<OpportunityMetrics> {
    const trx = trxOf(scope)
    const tenant = tenantOf(scope)
    // O período é [from, to] em dias completos (UTC).
    const range = [from, to] as never[]
    const entered = await trx.rawQuery(
      `select s.id as stage_id, s.code, s.name, count(h.id)::int as n
         from pipeline_stages s
         left join opportunity_stage_history h on h.tenant_id = s.tenant_id and h.to_stage_id = s.id
              and h.moved_at >= ?::date and h.moved_at < (?::date + 1)
        where s.tenant_id = ? and s.active
        group by s.id, s.code, s.name, s.position order by s.position`,
      [...range, tenant] as never[]
    )
    const closed = await trx.rawQuery(
      `select s.outcome, o.currency, count(*)::int as n, sum(o.expected_value)::numeric(19,4) as total,
              avg(extract(epoch from (h.moved_at - o.created_at)) / 86400.0) as days
         from opportunity_stage_history h
         join pipeline_stages s on s.tenant_id = h.tenant_id and s.id = h.to_stage_id and s.outcome is not null
         join opportunities o on o.tenant_id = h.tenant_id and o.id = h.opportunity_id
        where h.tenant_id = ? and h.moved_at >= ?::date and h.moved_at < (?::date + 1)
        group by s.outcome, o.currency`,
      [tenant, ...range] as never[]
    )
    const open = await trx.rawQuery(
      `select o.currency, sum(o.expected_value)::numeric(19,4) as total
         from opportunities o join pipeline_stages s on s.tenant_id = o.tenant_id and s.id = o.stage_id
        where o.tenant_id = ? and s.outcome is null group by o.currency order by o.currency`,
      [tenant] as never[]
    )
    const rows = closed.rows as {
      outcome: StageOutcome
      currency: string
      n: number
      total: string
      days: string | null
    }[]
    const won = rows.filter((r) => r.outcome === 'WON')
    const wonCount = won.reduce((s, r) => s + r.n, 0)
    const lostCount = rows.filter((r) => r.outcome === 'LOST').reduce((s, r) => s + r.n, 0)
    const closedCount = wonCount + lostCount
    // Taxa em texto decimal exacto (4 casas, arredondada), sem passar por `number`.
    const winRate =
      closedCount === 0
        ? null
        : (() => {
            const scaled =
              (BigInt(wonCount) * 20000n + BigInt(closedCount)) / (2n * BigInt(closedCount))
            return `${scaled / 10000n}.${String(scaled % 10000n).padStart(4, '0')}`
          })()
    let days: string | null = null
    if (wonCount > 0) {
      const weighted = won.reduce((s, r) => s + Number(r.days ?? 0) * r.n, 0)
      days = (weighted / wonCount).toFixed(2)
    }
    return {
      from,
      to,
      entered: (entered.rows as { stage_id: string; code: string; name: string; n: number }[]).map(
        (r) => ({ stageId: r.stage_id, code: r.code, name: r.name, count: r.n })
      ),
      won: wonCount,
      lost: lostCount,
      winRate,
      wonValue: won.map((r) => ({ currency: r.currency, value: r.total })),
      openValue: (open.rows as { currency: string; total: string }[]).map((r) => ({
        currency: r.currency,
        value: r.total,
      })),
      averageDaysToWin: days,
    }
  }
}

// --- actividades ------------------------------------------------------------------------------------

interface ActivityRow {
  id: string
  opportunity_id: string
  kind: ActivityKind
  subject: string
  notes: string | null
  due_at: Date | null
  done_at: Date | null
  owner_membership_id: string
  version: number
  created_at: Date
  updated_at: Date
}

const ACTIVITY_COLUMNS = `id, opportunity_id, kind, subject, notes, due_at, done_at, owner_membership_id, version,
  created_at, updated_at`

const toActivity = (r: ActivityRow): Activity => ({
  id: r.id,
  opportunityId: r.opportunity_id,
  kind: r.kind,
  subject: r.subject,
  notes: r.notes,
  dueAt: r.due_at === null ? null : iso(r.due_at),
  doneAt: r.done_at,
  ownerMembershipId: r.owner_membership_id,
  version: r.version,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

export class LucidActivityStore implements ActivityStore {
  async list(scope: TenantScope, opportunityId: string) {
    const result = await trxOf(scope).rawQuery(
      `select ${ACTIVITY_COLUMNS} from opportunity_activities
        where tenant_id = ? and opportunity_id = ? order by done_at is not null, due_at nulls last, created_at`,
      [tenantOf(scope), opportunityId] as never[]
    )
    return (result.rows as ActivityRow[]).map(toActivity)
  }

  async find(scope: TenantScope, id: string) {
    const result = await trxOf(scope).rawQuery(
      `select ${ACTIVITY_COLUMNS} from opportunity_activities where tenant_id = ? and id = ?`,
      [tenantOf(scope), id] as never[]
    )
    const [row] = result.rows as ActivityRow[]
    return row ? toActivity(row) : null
  }

  async insert(
    scope: TenantScope,
    opportunityId: string,
    ownerMembershipId: string,
    v: ActivityValues
  ) {
    const result = await trxOf(scope).rawQuery(
      `insert into opportunity_activities (tenant_id, opportunity_id, kind, subject, notes, due_at,
         owner_membership_id, created_by_membership_id, updated_by_membership_id)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?) returning ${ACTIVITY_COLUMNS}`,
      [
        tenantOf(scope),
        opportunityId,
        v.kind,
        v.subject,
        v.notes,
        v.dueAt,
        ownerMembershipId,
        actorOf(scope),
        actorOf(scope),
      ] as never[]
    )
    return toActivity(result.rows[0] as ActivityRow)
  }

  async complete(scope: TenantScope, id: string) {
    const result = await trxOf(scope).rawQuery(
      `update opportunity_activities
          set done_at = coalesce(done_at, now()), updated_at = now(), updated_by_membership_id = ?,
              version = version + 1
        where tenant_id = ? and id = ? returning ${ACTIVITY_COLUMNS}`,
      [actorOf(scope), tenantOf(scope), id] as never[]
    )
    return toActivity(result.rows[0] as ActivityRow)
  }
}

// --- campanhas --------------------------------------------------------------------------------------

interface CampaignRow {
  id: string
  name: string
  channel: CampaignChannel
  starts_at: Date
  ends_at: Date | null
  budget: string
  currency: string
  status: CampaignStatus
  version: number
  created_at: Date
  updated_at: Date
}

const CAMPAIGN_COLUMNS = `id, name, channel, starts_at, ends_at, budget, currency, status, version, created_at,
  updated_at`

const toCampaign = (r: CampaignRow): Campaign => ({
  id: r.id,
  name: r.name,
  channel: r.channel,
  startsAt: iso(r.starts_at),
  endsAt: r.ends_at === null ? null : iso(r.ends_at),
  budget: r.budget,
  currency: r.currency,
  status: r.status,
  version: r.version,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

interface SummaryRow {
  total: number
  targeted: number
  contacted: number
  responded: number
  opted_out: number
}

const SUMMARY_COLUMNS = `count(*)::int as total,
  count(*) filter (where status = 'TARGETED')::int as targeted,
  count(*) filter (where status = 'CONTACTED')::int as contacted,
  count(*) filter (where status = 'RESPONDED')::int as responded,
  count(*) filter (where status = 'OPTED_OUT')::int as opted_out`

const toSummary = (r: SummaryRow): CampaignSummary => ({
  total: r.total,
  targeted: r.targeted,
  contacted: r.contacted,
  responded: r.responded,
  optedOut: r.opted_out,
})

interface MemberRow {
  id: string
  campaign_id: string
  party_id: string | null
  lead_id: string | null
  party_name: string | null
  lead_name: string | null
  status: MemberStatus
  contacted_at: Date | null
  responded_at: Date | null
}

const MEMBER_SELECT = `
  select m.id, m.campaign_id, m.party_id, m.lead_id, p.display_name as party_name, l.name as lead_name, m.status,
         m.contacted_at, m.responded_at
    from campaign_members m
    left join parties p on p.tenant_id = m.tenant_id and p.id = m.party_id
    left join leads l on l.tenant_id = m.tenant_id and l.id = m.lead_id`

const toMember = (r: MemberRow): CampaignMember => ({
  id: r.id,
  campaignId: r.campaign_id,
  partyId: r.party_id,
  leadId: r.lead_id,
  partyName: r.party_name,
  leadName: r.lead_name,
  status: r.status,
  contactedAt: r.contacted_at,
  respondedAt: r.responded_at,
})

export class LucidCampaignStore implements CampaignStore {
  async list(scope: TenantScope, filter: CampaignFilter) {
    const where = ['c.tenant_id = ?']
    const params: unknown[] = [tenantOf(scope)]
    if (filter.status) {
      where.push('c.status = ?')
      params.push(filter.status)
    }
    if (filter.channel) {
      where.push('c.channel = ?')
      params.push(filter.channel)
    }
    const clause = where.join(' and ')
    const rows = await trxOf(scope).rawQuery(
      `select c.id, c.name, c.channel, c.starts_at, c.ends_at, c.budget, c.currency, c.status, c.version,
              c.created_at, c.updated_at,
              (select count(*)::int from campaign_members m where m.tenant_id = c.tenant_id and m.campaign_id = c.id) as total,
              (select count(*)::int from campaign_members m where m.tenant_id = c.tenant_id and m.campaign_id = c.id and m.status = 'TARGETED') as targeted,
              (select count(*)::int from campaign_members m where m.tenant_id = c.tenant_id and m.campaign_id = c.id and m.status = 'CONTACTED') as contacted,
              (select count(*)::int from campaign_members m where m.tenant_id = c.tenant_id and m.campaign_id = c.id and m.status = 'RESPONDED') as responded,
              (select count(*)::int from campaign_members m where m.tenant_id = c.tenant_id and m.campaign_id = c.id and m.status = 'OPTED_OUT') as opted_out
         from campaigns c where ${clause} order by c.starts_at desc, c.id limit ? offset ?`,
      [...params, filter.limit, filter.offset] as never[]
    )
    const count = await trxOf(scope).rawQuery(
      `select count(*)::int as total from campaigns c where ${clause}`,
      params as never[]
    )
    return {
      items: (rows.rows as (CampaignRow & SummaryRow)[]).map((r) => ({
        ...toCampaign(r),
        summary: toSummary(r),
      })),
      total: (count.rows[0] as { total: number }).total,
    }
  }

  async find(scope: TenantScope, id: string, lock = false) {
    const result = await trxOf(scope).rawQuery(
      `select ${CAMPAIGN_COLUMNS} from campaigns where tenant_id = ? and id = ?${lock ? ' for update' : ''}`,
      [tenantOf(scope), id] as never[]
    )
    const [row] = result.rows as CampaignRow[]
    return row ? toCampaign(row) : null
  }

  async insert(scope: TenantScope, v: CampaignValues) {
    const result = await trxOf(scope).rawQuery(
      `insert into campaigns (tenant_id, name, channel, starts_at, ends_at, budget, currency,
         created_by_membership_id, updated_by_membership_id)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?) returning ${CAMPAIGN_COLUMNS}`,
      [
        tenantOf(scope),
        v.name,
        v.channel,
        v.startsAt,
        v.endsAt,
        v.budget,
        v.currency,
        actorOf(scope),
        actorOf(scope),
      ] as never[]
    )
    return toCampaign(result.rows[0] as CampaignRow)
  }

  async update(scope: TenantScope, id: string, expectedVersion: number, v: CampaignValues) {
    const result = await trxOf(scope).rawQuery(
      `update campaigns
          set name = ?, starts_at = ?, ends_at = ?, budget = ?, updated_at = now(), updated_by_membership_id = ?,
              version = version + 1
        where tenant_id = ? and id = ? and version = ? returning ${CAMPAIGN_COLUMNS}`,
      [
        v.name,
        v.startsAt,
        v.endsAt,
        v.budget,
        actorOf(scope),
        tenantOf(scope),
        id,
        expectedVersion,
      ] as never[]
    )
    await versioned(result, () => this.find(scope, id))
    return toCampaign(result.rows[0] as CampaignRow)
  }

  async setStatus(scope: TenantScope, id: string, status: CampaignStatus) {
    const result = await trxOf(scope).rawQuery(
      `update campaigns set status = ?, updated_at = now(), updated_by_membership_id = ?, version = version + 1
        where tenant_id = ? and id = ? returning ${CAMPAIGN_COLUMNS}`,
      [status, actorOf(scope), tenantOf(scope), id] as never[]
    )
    return toCampaign(result.rows[0] as CampaignRow)
  }

  async summary(scope: TenantScope, id: string) {
    const result = await trxOf(scope).rawQuery(
      `select ${SUMMARY_COLUMNS} from campaign_members where tenant_id = ? and campaign_id = ?`,
      [tenantOf(scope), id] as never[]
    )
    return toSummary(result.rows[0] as SummaryRow)
  }

  async members(
    scope: TenantScope,
    campaignId: string,
    status: MemberStatus | undefined,
    limit: number,
    offset: number
  ) {
    const filter = status ? 'and m.status = ?' : ''
    const params = status ? [tenantOf(scope), campaignId, status] : [tenantOf(scope), campaignId]
    const rows = await trxOf(scope).rawQuery(
      `${MEMBER_SELECT} where m.tenant_id = ? and m.campaign_id = ? ${filter}
        order by m.created_at, m.id limit ? offset ?`,
      [...params, limit, offset] as never[]
    )
    const count = await trxOf(scope).rawQuery(
      `select count(*)::int as total from campaign_members m where m.tenant_id = ? and m.campaign_id = ? ${filter}`,
      params as never[]
    )
    return {
      items: (rows.rows as MemberRow[]).map(toMember),
      total: (count.rows[0] as { total: number }).total,
    }
  }

  async membersToSend(scope: TenantScope, campaignId: string): Promise<SendTarget[]> {
    const result = await trxOf(scope).rawQuery(
      `select m.id, m.party_id, m.lead_id, l.email as lead_email, l.phone as lead_phone,
              l.consent_status as lead_consent
         from campaign_members m
         left join leads l on l.tenant_id = m.tenant_id and l.id = m.lead_id
        where m.tenant_id = ? and m.campaign_id = ? and m.status = 'TARGETED' order by m.created_at, m.id`,
      [tenantOf(scope), campaignId] as never[]
    )
    return (
      result.rows as {
        id: string
        party_id: string | null
        lead_id: string | null
        lead_email: string | null
        lead_phone: string | null
        lead_consent: ConsentStatus | null
      }[]
    ).map((r) => ({
      memberId: r.id,
      partyId: r.party_id,
      leadId: r.lead_id,
      leadEmail: r.lead_email,
      leadPhone: r.lead_phone,
      leadConsent: r.lead_consent,
    }))
  }

  async addMember(
    scope: TenantScope,
    campaignId: string,
    target: { partyId: string } | { leadId: string }
  ) {
    const partyId = 'partyId' in target ? target.partyId : null
    const leadId = 'leadId' in target ? target.leadId : null
    const conflict =
      partyId !== null
        ? `(tenant_id, campaign_id, party_id) where party_id is not null`
        : `(tenant_id, campaign_id, lead_id) where lead_id is not null`
    const result = await trxOf(scope).rawQuery(
      `insert into campaign_members (tenant_id, campaign_id, party_id, lead_id, created_by_membership_id,
         updated_by_membership_id)
       values (?, ?, ?, ?, ?, ?) on conflict ${conflict} do nothing returning id`,
      [tenantOf(scope), campaignId, partyId, leadId, actorOf(scope), actorOf(scope)] as never[]
    )
    const row = result.rows[0] as { id: string } | undefined
    return row ? await this.findMember(scope, campaignId, row.id) : null
  }

  async findMember(scope: TenantScope, campaignId: string, memberId: string) {
    const result = await trxOf(scope).rawQuery(
      `${MEMBER_SELECT} where m.tenant_id = ? and m.campaign_id = ? and m.id = ?`,
      [tenantOf(scope), campaignId, memberId] as never[]
    )
    const [row] = result.rows as MemberRow[]
    return row ? toMember(row) : null
  }

  async removeMember(scope: TenantScope, campaignId: string, memberId: string) {
    const result = await trxOf(scope).rawQuery(
      `delete from campaign_members where tenant_id = ? and campaign_id = ? and id = ? and status = 'TARGETED' returning id`,
      [tenantOf(scope), campaignId, memberId] as never[]
    )
    return result.rows.length > 0
  }

  async setMemberStatus(scope: TenantScope, memberId: string, status: MemberStatus) {
    await trxOf(scope).rawQuery(
      `update campaign_members
          set status = ?,
              contacted_at = case when ? = 'CONTACTED' then now() else contacted_at end,
              responded_at = case when ? = 'RESPONDED' then now() else responded_at end,
              updated_at = now(), updated_by_membership_id = ?, version = version + 1
        where tenant_id = ? and id = ?`,
      [status, status, status, actorOf(scope), tenantOf(scope), memberId] as never[]
    )
    const result = await trxOf(scope).rawQuery(
      `${MEMBER_SELECT} where m.tenant_id = ? and m.id = ?`,
      [tenantOf(scope), memberId] as never[]
    )
    return toMember(result.rows[0] as MemberRow)
  }
}

// --- exclusões --------------------------------------------------------------------------------------

export class LucidExclusionStore implements ExclusionStore {
  async list(scope: TenantScope, limit: number, offset: number) {
    const rows = await trxOf(scope).rawQuery(
      `select id, kind, value, reason, created_at from marketing_exclusions
        where tenant_id = ? order by created_at desc, id limit ? offset ?`,
      [tenantOf(scope), limit, offset] as never[]
    )
    const count = await trxOf(scope).rawQuery(
      `select count(*)::int as total from marketing_exclusions where tenant_id = ?`,
      [tenantOf(scope)] as never[]
    )
    return {
      items: (
        rows.rows as {
          id: string
          kind: ExclusionKind
          value: string
          reason: string | null
          created_at: Date
        }[]
      ).map<Exclusion>((r) => ({
        id: r.id,
        kind: r.kind,
        value: r.value,
        reason: r.reason,
        createdAt: r.created_at,
      })),
      total: (count.rows[0] as { total: number }).total,
    }
  }

  async insert(
    scope: TenantScope,
    v: { kind: ExclusionKind; value: string; reason: string | null }
  ) {
    const result = await trxOf(scope).rawQuery(
      `insert into marketing_exclusions (tenant_id, kind, value, reason, created_by_membership_id,
         updated_by_membership_id)
       values (?, ?, ?, ?, ?, ?) on conflict (tenant_id, kind, value) do nothing
       returning id, kind, value, reason, created_at`,
      [tenantOf(scope), v.kind, v.value, v.reason, actorOf(scope), actorOf(scope)] as never[]
    )
    const row = result.rows[0] as
      | { id: string; kind: ExclusionKind; value: string; reason: string | null; created_at: Date }
      | undefined
    return row
      ? {
          id: row.id,
          kind: row.kind,
          value: row.value,
          reason: row.reason,
          createdAt: row.created_at,
        }
      : null
  }

  async remove(scope: TenantScope, id: string) {
    const result = await trxOf(scope).rawQuery(
      `delete from marketing_exclusions where tenant_id = ? and id = ? returning id`,
      [tenantOf(scope), id] as never[]
    )
    return result.rows.length > 0
  }

  async excluded(scope: TenantScope, kind: ExclusionKind, values: readonly string[]) {
    if (values.length === 0) return new Set<string>()
    const result = await trxOf(scope).rawQuery(
      `select value from marketing_exclusions where tenant_id = ? and kind = ? and value = any(?::text[])`,
      [tenantOf(scope), kind, [...values]] as never[]
    )
    return new Set((result.rows as { value: string }[]).map((r) => r.value))
  }
}
