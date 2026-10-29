import { ApiError } from '#core/http/api_error'
import type { OutboxWriter } from '#core/outbox/index'
import type { TenantContext, TenantScope, TenantUnitOfWork } from '#core/tenancy/index'
import {
  CAMPAIGN_TRANSITIONS,
  DEFAULT_PIPELINE,
  DEFAULT_STAGES,
  destinationKind,
  exclusionValue,
  isIsoDate,
  normalizeActivity,
  normalizeCampaign,
  normalizeCustomerCode,
  normalizeLead,
  normalizeOpportunity,
  normalizeStage,
  planMove,
  sendDecision,
  splitName,
  type CampaignStatus,
  type ExclusionKind,
  type Issue,
  type LeadInput,
  type MemberStatus,
  type OpportunityInput,
  type StageInput,
} from '#modules/prospecting/domain/prospecting'
import {
  prospectingValidation,
  failure,
  MAX_MEMBERS_PER_CALL,
  MAX_PAGE,
  todayOf,
  type Clock,
} from '#modules/prospecting/application/errors'
import type {
  Activity,
  ActivityStore,
  Campaign,
  CampaignMember,
  CampaignStore,
  CampaignSummary,
  Exclusion,
  ExclusionStore,
  Lead,
  LeadStore,
  Opportunity,
  OpportunityMetrics,
  OpportunityStore,
  References,
  Stage,
  StageMove,
  StageStore,
} from '#modules/prospecting/application/ports'

const page = (filter: { limit?: number; offset?: number }) => ({
  limit: Math.min(filter.limit ?? 50, MAX_PAGE),
  offset: filter.offset ?? 0,
})

const actorOf = (context: TenantContext): string => {
  if (!context.membershipId) throw ApiError.notFound()
  return context.membershipId
}

// --- etapas do pipeline -----------------------------------------------------------------------------

/** Etapas do pipeline. Um tenant sem etapas recebe as por omissão ao primeiro uso (idempotente). */
export class StageUseCases {
  constructor(
    private readonly uow: TenantUnitOfWork,
    private readonly stages: StageStore
  ) {}

  /** As etapas activas (ou todas), criando as por omissão se o pipeline ainda não tem nenhuma. */
  async ensure(scope: TenantScope, pipelineCode: string, activeOnly: boolean): Promise<Stage[]> {
    let found = await this.stages.list(scope, pipelineCode, activeOnly)
    if (pipelineCode === DEFAULT_PIPELINE && found.length === 0) {
      await this.stages.insertMissing(scope, DEFAULT_STAGES)
      found = await this.stages.list(scope, pipelineCode, activeOnly)
    }
    return found
  }

  list(context: TenantContext, filter: { pipelineCode?: string; activeOnly?: boolean }) {
    return this.uow.run(
      (scope) =>
        this.ensure(scope, filter.pipelineCode ?? DEFAULT_PIPELINE, filter.activeOnly ?? false),
      context
    )
  }

  create(context: TenantContext, input: StageInput): Promise<Stage> {
    const issues: Issue[] = []
    const values = normalizeStage(input, null, issues)
    if (!values) throw prospectingValidation(issues)
    return this.uow.run(async (scope) => {
      const created = await this.stages.insert(scope, values)
      if (created === 'CODE') {
        throw ApiError.conflict('STAGE_CODE_TAKEN', 'Já existe uma etapa com este código.')
      }
      return created
    }, context)
  }

  update(
    context: TenantContext,
    id: string,
    input: StageInput & { expectedVersion: number }
  ): Promise<Stage> {
    return this.uow.run(async (scope) => {
      const current = await this.stages.find(scope, id)
      if (!current) throw ApiError.notFound()
      const issues: Issue[] = []
      const values = normalizeStage(input, current, issues)
      if (!values) throw prospectingValidation(issues)
      if (current.active && !values.active) {
        if (current.terminal) {
          throw ApiError.conflict('STAGE_TERMINAL', 'Uma etapa de ganho ou perda não se desactiva.')
        }
        if ((await this.stages.openCount(scope, id)) > 0) {
          throw ApiError.conflict(
            'STAGE_IN_USE',
            'Há oportunidades nesta etapa: mova-as antes de a desactivar.'
          )
        }
      }
      return this.stages.update(scope, id, input.expectedVersion, values)
    }, context)
  }
}

// --- leads ------------------------------------------------------------------------------------------

export interface ConvertInput {
  organizationId?: unknown
  partyId?: unknown
  customerCode?: unknown
  opportunity?: {
    name?: unknown
    stageId?: unknown
    expectedValue?: unknown
    currency?: unknown
    expectedCloseDate?: unknown
  }
}

export interface ConvertResult {
  lead: Lead
  partyId: string
  customerId: string
  opportunityId: string | null
  /** `true` quando a lead já estava convertida: os identificadores são os da primeira conversão. */
  alreadyConverted: boolean
}

/** Leads (M02): qualificar, desqualificar e converter. A conversão é atómica e idempotente. */
export class LeadUseCases {
  constructor(
    private readonly uow: TenantUnitOfWork,
    private readonly leads: LeadStore,
    private readonly opportunities: OpportunityStore,
    private readonly stages: StageUseCases,
    private readonly references: References,
    private readonly outbox: OutboxWriter
  ) {}

  list(
    context: TenantContext,
    filter: {
      q?: string
      status?: Lead['status']
      ownerMembershipId?: string
      consentStatus?: Lead['consentStatus']
      limit?: number
      offset?: number
    }
  ) {
    return this.uow.run((scope) => this.leads.list(scope, { ...filter, ...page(filter) }), context)
  }

  get(context: TenantContext, id: string): Promise<Lead> {
    return this.uow.run(async (scope) => {
      const lead = await this.leads.find(scope, id)
      if (!lead) throw ApiError.notFound()
      return lead
    }, context)
  }

  async create(
    context: TenantContext,
    input: LeadInput & { ownerMembershipId?: unknown }
  ): Promise<Lead> {
    const issues: Issue[] = []
    const values = normalizeLead(input, null, issues)
    if (!values) throw prospectingValidation(issues)
    const owner =
      typeof input.ownerMembershipId === 'string' ? input.ownerMembershipId : actorOf(context)
    return this.uow.run(async (scope) => {
      if (!(await this.references.membershipActive(scope, owner))) {
        throw failure('ownerMembershipId', 'UNKNOWN_OWNER', 'O responsável não é um membro activo.')
      }
      return this.leads.insert(scope, { ...values, ownerMembershipId: owner })
    }, context)
  }

  update(
    context: TenantContext,
    id: string,
    input: LeadInput & { expectedVersion: number; ownerMembershipId?: unknown }
  ): Promise<Lead> {
    return this.uow.run(async (scope) => {
      const current = await this.leads.find(scope, id)
      if (!current) throw ApiError.notFound()
      const issues: Issue[] = []
      const values = normalizeLead(input, current, issues)
      if (!values) throw prospectingValidation(issues)
      const owner =
        typeof input.ownerMembershipId === 'string'
          ? input.ownerMembershipId
          : current.ownerMembershipId
      if (
        owner !== current.ownerMembershipId &&
        !(await this.references.membershipActive(scope, owner))
      ) {
        throw failure('ownerMembershipId', 'UNKNOWN_OWNER', 'O responsável não é um membro activo.')
      }
      return this.leads.update(scope, id, input.expectedVersion, {
        ...values,
        ownerMembershipId: owner,
      })
    }, context)
  }

  /** Qualificar: `NEW` ou `DISQUALIFIED` → `QUALIFIED`. Repetir não faz nada. */
  qualify(context: TenantContext, id: string): Promise<Lead> {
    return this.uow.run(async (scope) => {
      const lead = await this.leads.find(scope, id, true)
      if (!lead) throw ApiError.notFound()
      if (lead.status === 'QUALIFIED') return lead
      if (lead.status === 'CONVERTED') {
        throw ApiError.conflict('LEAD_CONVERTED', 'Uma lead convertida já não se qualifica.')
      }
      return this.leads.setStatus(scope, id, { status: 'QUALIFIED' })
    }, context)
  }

  disqualify(context: TenantContext, id: string, reason: unknown): Promise<Lead> {
    const text = typeof reason === 'string' ? reason.trim() : ''
    if (text.length === 0 || text.length > 300) {
      throw failure('reason', 'REASON_REQUIRED', 'Indique o motivo (até 300 caracteres).')
    }
    return this.uow.run(async (scope) => {
      const lead = await this.leads.find(scope, id, true)
      if (!lead) throw ApiError.notFound()
      if (lead.status === 'DISQUALIFIED') return lead
      if (lead.status === 'CONVERTED') {
        throw ApiError.conflict('LEAD_CONVERTED', 'Uma lead convertida já não se desqualifica.')
      }
      return this.leads.setStatus(scope, id, { status: 'DISQUALIFIED', reason: text })
    }, context)
  }

  /**
   * Converte a lead em Party, cliente e oportunidade **numa só transacção** (os casos de uso das Party e dos clientes
   * juntam-se a ela). Idempotente: repetir devolve os mesmos identificadores, também em simultâneo (a lead fica
   * bloqueada) e depois de um erro (tudo reverteu). Resolve a Party por esta ordem: a indicada, a já ligada à lead, uma
   * existente com o mesmo email; senão cria-a. Reutiliza o cliente que a Party já tenha nesta organização.
   */
  convert(context: TenantContext, id: string, input: ConvertInput): Promise<ConvertResult> {
    const organizationId = typeof input.organizationId === 'string' ? input.organizationId : ''
    if (!organizationId) throw failure('organizationId', 'REQUIRED', 'Indique a organização.')
    return this.uow.run(async (scope) => {
      const lead = await this.leads.find(scope, id, true)
      if (!lead) throw ApiError.notFound()
      if (lead.status === 'CONVERTED') {
        return {
          lead,
          partyId: lead.partyId as string,
          customerId: lead.customerId as string,
          opportunityId: lead.opportunityId,
          alreadyConverted: true,
        }
      }
      if (lead.status === 'DISQUALIFIED') {
        throw ApiError.conflict(
          'LEAD_DISQUALIFIED',
          'Uma lead desqualificada tem de ser requalificada.'
        )
      }
      const currency = await this.references.organizationCurrency(context, organizationId)
      if (currency === null) {
        throw failure('organizationId', 'UNKNOWN_ORGANIZATION', 'A organização não existe.')
      }
      const issues: Issue[] = []
      const customerCode = normalizeCustomerCode(input.customerCode, lead.id, issues)
      const oppInput = input.opportunity ?? {}
      const opportunityValues = normalizeOpportunity(
        {
          organizationId,
          leadId: lead.id,
          name: oppInput.name ?? lead.companyName ?? lead.name,
          stageId: oppInput.stageId,
          expectedValue: oppInput.expectedValue,
          currency: oppInput.currency,
          expectedCloseDate: oppInput.expectedCloseDate,
        },
        null,
        currency,
        issues
      )
      if (!opportunityValues || issues.length > 0) throw prospectingValidation(issues)

      // Party: a indicada, a já ligada, uma com o mesmo email ou uma nova.
      let partyId: string | null = null
      if (typeof input.partyId === 'string') {
        if (!(await this.references.partyExists(context, input.partyId))) {
          throw failure('partyId', 'UNKNOWN_PARTY', 'A pessoa ou organização não existe.')
        }
        partyId = input.partyId
      } else if (lead.partyId) {
        partyId = lead.partyId
      } else if (lead.email) {
        const found = await this.references.partyByEmail(context, lead.email)
        partyId = found ? found.id : null
      }
      let partyCreated = false
      if (!partyId) {
        let created
        if (lead.companyName) {
          created = await this.references.createParty(context, {
            kind: 'ORGANIZATION',
            displayName: lead.companyName,
            legalName: lead.companyName,
            email: lead.email,
            phone: lead.phone,
          })
        } else {
          const names = splitName(lead.name)
          if (!names) {
            throw failure(
              'name',
              'PARTY_NAME_INCOMPLETE',
              'Indique nome e apelido na lead, ou ligue uma pessoa ou organização existente.'
            )
          }
          created = await this.references.createParty(context, {
            kind: 'PERSON',
            displayName: lead.name,
            ...names,
            email: lead.email,
            phone: lead.phone,
          })
        }
        partyId = created.id
        partyCreated = true
      }

      let customer = await this.references.customerOfParty(context, partyId, organizationId)
      const customerCreated = customer === null
      if (!customer) {
        customer = await this.references.createCustomer(context, {
          partyId,
          organizationId,
          code: customerCode,
          accountManagerMembershipId: lead.ownerMembershipId,
        })
      }

      const stages = await this.stages.ensure(scope, DEFAULT_PIPELINE, true)
      const stage =
        typeof oppInput.stageId === 'string'
          ? stages.find((s) => s.id === oppInput.stageId)
          : stages.find((s) => !s.terminal)
      if (!stage || stage.terminal) {
        throw failure('stageId', 'UNKNOWN_STAGE', 'A etapa inicial não existe ou é de ganho/perda.')
      }
      const opportunity = await this.opportunities.insert(scope, {
        ...opportunityValues,
        customerId: customer.id,
        stageId: stage.id,
        ownerMembershipId: lead.ownerMembershipId,
      })
      await this.opportunities.insertMove(scope, {
        opportunityId: opportunity.id,
        fromStageId: null,
        toStageId: stage.id,
      })
      const converted = await this.leads.markConverted(scope, id, {
        partyId,
        customerId: customer.id,
        opportunityId: opportunity.id,
      })
      await this.outbox.append(scope, {
        aggregateType: 'lead',
        aggregateId: id,
        aggregateVersion: converted.version,
        eventType: 'crm.lead.converted',
        payload: {
          leadId: id,
          partyId,
          customerId: customer.id,
          opportunityId: opportunity.id,
          partyCreated,
          customerCreated,
        },
        correlationId: context.correlationId,
      })
      return {
        lead: converted,
        partyId,
        customerId: customer.id,
        opportunityId: opportunity.id,
        alreadyConverted: false,
      }
    }, context)
  }
}

// --- oportunidades ----------------------------------------------------------------------------------

export interface OpportunityDetail extends Opportunity {
  history: StageMove[]
  activities: Activity[]
}

/** Oportunidades e o seu pipeline: mover é uma transição autorizada com histórico de datas. */
export class OpportunityUseCases {
  constructor(
    private readonly uow: TenantUnitOfWork,
    private readonly opportunities: OpportunityStore,
    private readonly activities: ActivityStore,
    private readonly leads: LeadStore,
    private readonly stages: StageUseCases,
    private readonly stageStore: StageStore,
    private readonly references: References,
    private readonly outbox: OutboxWriter,
    private readonly clock: Clock
  ) {}

  list(
    context: TenantContext,
    filter: {
      stageId?: string
      ownerMembershipId?: string
      customerId?: string
      leadId?: string
      status?: 'open' | 'won' | 'lost'
      q?: string
      limit?: number
      offset?: number
    }
  ) {
    return this.uow.run(
      (scope) => this.opportunities.list(scope, { ...filter, ...page(filter) }),
      context
    )
  }

  get(context: TenantContext, id: string): Promise<OpportunityDetail> {
    return this.uow.run(async (scope) => {
      const found = await this.opportunities.find(scope, id)
      if (!found) throw ApiError.notFound()
      return {
        ...found,
        history: await this.opportunities.history(scope, id),
        activities: await this.activities.list(scope, id),
      }
    }, context)
  }

  async create(
    context: TenantContext,
    input: OpportunityInput & { ownerMembershipId?: unknown }
  ): Promise<Opportunity> {
    const customerId = typeof input.customerId === 'string' ? input.customerId : null
    const customer = customerId ? await this.references.customer(context, customerId) : null
    if (customerId && !customer) {
      throw failure('customerId', 'UNKNOWN_CUSTOMER', 'O cliente não existe.')
    }
    const organizationId =
      typeof input.organizationId === 'string' ? input.organizationId : customer?.organizationId
    const currency = organizationId
      ? await this.references.organizationCurrency(context, organizationId)
      : null
    if (organizationId && currency === null) {
      throw failure('organizationId', 'UNKNOWN_ORGANIZATION', 'A organização não existe.')
    }
    const issues: Issue[] = []
    const values = normalizeOpportunity(
      { ...input, organizationId },
      null,
      currency ?? customer?.currency ?? 'AOA',
      issues
    )
    if (!values) throw prospectingValidation(issues)
    const owner =
      typeof input.ownerMembershipId === 'string' ? input.ownerMembershipId : actorOf(context)
    return this.uow.run(async (scope) => {
      if (!(await this.references.membershipActive(scope, owner))) {
        throw failure('ownerMembershipId', 'UNKNOWN_OWNER', 'O responsável não é um membro activo.')
      }
      if (values.leadId) {
        const lead = await this.leads.find(scope, values.leadId)
        if (!lead) throw failure('leadId', 'UNKNOWN_LEAD', 'A lead não existe.')
      }
      const stages = await this.stages.ensure(scope, DEFAULT_PIPELINE, true)
      const stage = values.stageId
        ? stages.find((s) => s.id === values.stageId)
        : stages.find((s) => !s.terminal)
      if (!stage || stage.terminal) {
        throw failure('stageId', 'UNKNOWN_STAGE', 'A etapa inicial não existe ou é de ganho/perda.')
      }
      const created = await this.opportunities.insert(scope, {
        ...values,
        stageId: stage.id,
        ownerMembershipId: owner,
      })
      await this.opportunities.insertMove(scope, {
        opportunityId: created.id,
        fromStageId: null,
        toStageId: stage.id,
      })
      return created
    }, context)
  }

  update(
    context: TenantContext,
    id: string,
    input: OpportunityInput & { expectedVersion: number }
  ): Promise<Opportunity> {
    return this.uow.run(async (scope) => {
      const current = await this.opportunities.find(scope, id)
      if (!current) throw ApiError.notFound()
      if (current.outcome !== null) {
        throw ApiError.conflict(
          'OPPORTUNITY_CLOSED',
          'Uma oportunidade ganha ou perdida já não se altera.'
        )
      }
      const issues: Issue[] = []
      const values = normalizeOpportunity(
        {
          name: input.name,
          expectedValue: input.expectedValue,
          expectedCloseDate: input.expectedCloseDate,
          currency: input.currency,
        },
        { ...current, stageId: current.stageId },
        current.currency,
        issues
      )
      if (!values) throw prospectingValidation(issues)
      return this.opportunities.update(scope, id, input.expectedVersion, {
        ...values,
        stageId: current.stageId,
      })
    }, context)
  }

  /**
   * Move a oportunidade de etapa e regista a transição (com a data) no histórico. Fechada não se move; perder exige
   * motivo; ganhar exige a evidência quando a etapa o configura. Ganhar não cria recebimento nem factura. Repetir o
   * pedido para a etapa onde já está não faz nada.
   */
  move(
    context: TenantContext,
    id: string,
    input: {
      stageId: string
      expectedVersion?: number
      lossReason?: unknown
      winEvidence?: unknown
    }
  ): Promise<Opportunity> {
    return this.uow.run(async (scope) => {
      const current = await this.opportunities.find(scope, id, true)
      if (!current) throw ApiError.notFound()
      if (input.expectedVersion !== undefined && input.expectedVersion !== current.version) {
        throw ApiError.versionConflict(current.version)
      }
      const target = await this.stageStore.find(scope, input.stageId)
      if (!target) throw failure('stageId', 'UNKNOWN_STAGE', 'A etapa não existe.')
      const plan = planMove(
        {
          id: current.stageId,
          outcome: current.outcome,
          requiresEvidence: false,
          active: true,
        },
        target,
        input
      )
      if ('issues' in plan) {
        if (plan.issues.some((i) => i.code === 'OPPORTUNITY_CLOSED')) {
          throw ApiError.conflict('OPPORTUNITY_CLOSED', plan.issues[0]?.message ?? '', plan.issues)
        }
        throw prospectingValidation(plan.issues)
      }
      if (plan.noop) return current
      const moved = await this.opportunities.moveTo(scope, id, {
        stageId: target.id,
        closed: target.outcome !== null,
        lossReason: plan.lossReason,
        winEvidence: plan.winEvidence,
      })
      await this.opportunities.insertMove(scope, {
        opportunityId: id,
        fromStageId: current.stageId,
        toStageId: target.id,
      })
      await this.outbox.append(scope, {
        aggregateType: 'opportunity',
        aggregateId: id,
        aggregateVersion: moved.version,
        eventType:
          target.outcome === 'WON'
            ? 'crm.opportunity.won'
            : target.outcome === 'LOST'
              ? 'crm.opportunity.lost'
              : 'crm.opportunity.moved',
        payload: {
          opportunityId: id,
          customerId: moved.customerId,
          fromStageId: current.stageId,
          toStageId: target.id,
          expectedValue: moved.expectedValue,
          currency: moved.currency,
        },
        correlationId: context.correlationId,
      })
      return moved
    }, context)
  }

  history(context: TenantContext, id: string): Promise<StageMove[]> {
    return this.uow.run(async (scope) => {
      if (!(await this.opportunities.find(scope, id))) throw ApiError.notFound()
      return this.opportunities.history(scope, id)
    }, context)
  }

  metrics(
    context: TenantContext,
    range: { from?: string; to?: string }
  ): Promise<OpportunityMetrics> {
    const to = range.to ?? todayOf(this.clock)
    const from =
      range.from ??
      new Date(Date.parse(`${to}T00:00:00Z`) - 29 * 86_400_000).toISOString().slice(0, 10)
    const issues: Issue[] = []
    if (!isIsoDate(from))
      issues.push({ path: 'from', code: 'INVALID_DATE', message: 'Data inválida.' })
    if (!isIsoDate(to)) issues.push({ path: 'to', code: 'INVALID_DATE', message: 'Data inválida.' })
    if (issues.length === 0 && from > to) {
      issues.push({ path: 'from', code: 'BEFORE_START', message: 'O início é posterior ao fim.' })
    }
    if (issues.length > 0) throw prospectingValidation(issues)
    return this.uow.run((scope) => this.opportunities.metrics(scope, from, to), context)
  }

  // --- actividades ----------------------------------------------------------------------------

  listActivities(context: TenantContext, opportunityId: string): Promise<Activity[]> {
    return this.uow.run(async (scope) => {
      if (!(await this.opportunities.find(scope, opportunityId))) throw ApiError.notFound()
      return this.activities.list(scope, opportunityId)
    }, context)
  }

  addActivity(
    context: TenantContext,
    opportunityId: string,
    input: { kind?: unknown; subject?: unknown; notes?: unknown; dueAt?: unknown }
  ): Promise<Activity> {
    const issues: Issue[] = []
    const values = normalizeActivity(input, issues)
    if (!values) throw prospectingValidation(issues)
    return this.uow.run(async (scope) => {
      if (!(await this.opportunities.find(scope, opportunityId))) throw ApiError.notFound()
      return this.activities.insert(scope, opportunityId, actorOf(context), values)
    }, context)
  }

  /** Conclui uma actividade. Repetir não faz nada. */
  completeActivity(context: TenantContext, id: string): Promise<Activity> {
    return this.uow.run(async (scope) => {
      const found = await this.activities.find(scope, id)
      if (!found) throw ApiError.notFound()
      return found.doneAt ? found : this.activities.complete(scope, id)
    }, context)
  }
}

// --- campanhas --------------------------------------------------------------------------------------

export interface SendResult {
  sent: number
  optedOut: number
  noConsent: number
  noDestination: number
}

/**
 * Campanhas: público, custo e respostas. O envio respeita o consentimento e a lista de exclusão e pede a entrega ao
 * serviço de notificações por um evento do outbox (a entrega propriamente dita não é deste módulo).
 */
export class CampaignUseCases {
  constructor(
    private readonly uow: TenantUnitOfWork,
    private readonly campaigns: CampaignStore,
    private readonly leads: LeadStore,
    private readonly exclusions: ExclusionStore,
    private readonly references: References,
    private readonly outbox: OutboxWriter,
    private readonly clock: Clock
  ) {}

  list(
    context: TenantContext,
    filter: {
      status?: CampaignStatus
      channel?: Campaign['channel']
      limit?: number
      offset?: number
    }
  ) {
    return this.uow.run(
      (scope) => this.campaigns.list(scope, { ...filter, ...page(filter) }),
      context
    )
  }

  get(context: TenantContext, id: string): Promise<Campaign & { summary: CampaignSummary }> {
    return this.uow.run(async (scope) => {
      const found = await this.campaigns.find(scope, id)
      if (!found) throw ApiError.notFound()
      return { ...found, summary: await this.campaigns.summary(scope, id) }
    }, context)
  }

  async create(
    context: TenantContext,
    input: {
      name?: unknown
      channel?: unknown
      startsAt?: unknown
      endsAt?: unknown
      budget?: unknown
      currency?: unknown
      organizationId?: unknown
    }
  ): Promise<Campaign> {
    const organizationId = typeof input.organizationId === 'string' ? input.organizationId : null
    const orgCurrency = organizationId
      ? await this.references.organizationCurrency(context, organizationId)
      : null
    if (organizationId && orgCurrency === null) {
      throw failure('organizationId', 'UNKNOWN_ORGANIZATION', 'A organização não existe.')
    }
    const issues: Issue[] = []
    const values = normalizeCampaign(input, null, orgCurrency ?? 'AOA', issues)
    if (!values) throw prospectingValidation(issues)
    return this.uow.run((scope) => this.campaigns.insert(scope, values), context)
  }

  update(
    context: TenantContext,
    id: string,
    input: {
      name?: unknown
      channel?: unknown
      startsAt?: unknown
      endsAt?: unknown
      budget?: unknown
      currency?: unknown
      expectedVersion: number
    }
  ): Promise<Campaign> {
    return this.uow.run(async (scope) => {
      const current = await this.campaigns.find(scope, id)
      if (!current) throw ApiError.notFound()
      if (current.status === 'COMPLETED') {
        throw ApiError.conflict('CAMPAIGN_COMPLETED', 'Uma campanha concluída já não se altera.')
      }
      const issues: Issue[] = []
      const values = normalizeCampaign(input, current, current.currency, issues)
      if (!values) throw prospectingValidation(issues)
      return this.campaigns.update(scope, id, input.expectedVersion, values)
    }, context)
  }

  /** Rascunho → activa ⇄ pausada → concluída. Repetir o estado actual não faz nada. */
  setStatus(context: TenantContext, id: string, status: CampaignStatus): Promise<Campaign> {
    return this.uow.run(async (scope) => {
      const current = await this.campaigns.find(scope, id, true)
      if (!current) throw ApiError.notFound()
      if (current.status === status) return current
      if (!CAMPAIGN_TRANSITIONS[current.status].includes(status)) {
        throw ApiError.conflict(
          'CAMPAIGN_STATE',
          `Uma campanha ${current.status} não passa a ${status}.`
        )
      }
      return this.campaigns.setStatus(scope, id, status)
    }, context)
  }

  members(
    context: TenantContext,
    id: string,
    filter: { status?: MemberStatus; limit?: number; offset?: number }
  ) {
    const { limit, offset } = page(filter)
    return this.uow.run(async (scope) => {
      if (!(await this.campaigns.find(scope, id))) throw ApiError.notFound()
      return this.campaigns.members(scope, id, filter.status, limit, offset)
    }, context)
  }

  /** Acrescenta destinatários (Party ou lead). Os que já estavam contam como repetidos. */
  addMembers(
    context: TenantContext,
    id: string,
    input: { partyIds?: readonly string[]; leadIds?: readonly string[] }
  ): Promise<{ added: number; duplicates: number }> {
    const parties = [...new Set(input.partyIds ?? [])]
    const leads = [...new Set(input.leadIds ?? [])]
    if (parties.length + leads.length === 0) {
      throw failure('partyIds', 'REQUIRED', 'Indique pelo menos um destinatário.')
    }
    if (parties.length + leads.length > MAX_MEMBERS_PER_CALL) {
      throw failure(
        'partyIds',
        'TOO_MANY',
        `No máximo ${MAX_MEMBERS_PER_CALL} destinatários por pedido.`
      )
    }
    return this.uow.run(async (scope) => {
      const campaign = await this.campaigns.find(scope, id, true)
      if (!campaign) throw ApiError.notFound()
      if (campaign.status === 'COMPLETED') {
        throw ApiError.conflict(
          'CAMPAIGN_COMPLETED',
          'Uma campanha concluída já não recebe destinatários.'
        )
      }
      const issues: Issue[] = []
      for (const partyId of parties) {
        if (!(await this.references.partyExists(context, partyId))) {
          issues.push({
            path: 'partyIds',
            code: 'UNKNOWN_PARTY',
            message: `Party inexistente: ${partyId}`,
          })
        }
      }
      for (const leadId of leads) {
        if (!(await this.leads.find(scope, leadId))) {
          issues.push({
            path: 'leadIds',
            code: 'UNKNOWN_LEAD',
            message: `Lead inexistente: ${leadId}`,
          })
        }
      }
      if (issues.length > 0) throw prospectingValidation(issues)
      let added = 0
      for (const partyId of parties) {
        if (await this.campaigns.addMember(scope, id, { partyId })) added++
      }
      for (const leadId of leads) {
        if (await this.campaigns.addMember(scope, id, { leadId })) added++
      }
      return { added, duplicates: parties.length + leads.length - added }
    }, context)
  }

  removeMember(context: TenantContext, id: string, memberId: string): Promise<void> {
    return this.uow.run(async (scope) => {
      const member = await this.campaigns.findMember(scope, id, memberId)
      if (!member) throw ApiError.notFound()
      if (!(await this.campaigns.removeMember(scope, id, memberId))) {
        throw ApiError.conflict(
          'MEMBER_ALREADY_CONTACTED',
          'Só se retira um destinatário que ainda não foi contactado.'
        )
      }
    }, context)
  }

  /** O destinatário respondeu (só depois de contactado). Repetir não faz nada. */
  respond(context: TenantContext, id: string, memberId: string): Promise<CampaignMember> {
    return this.uow.run(async (scope) => {
      const member = await this.campaigns.findMember(scope, id, memberId)
      if (!member) throw ApiError.notFound()
      if (member.status === 'RESPONDED') return member
      if (member.status !== 'CONTACTED') {
        throw ApiError.conflict('MEMBER_NOT_CONTACTED', 'Só responde quem já foi contactado.')
      }
      return this.campaigns.setMemberStatus(scope, memberId, 'RESPONDED')
    }, context)
  }

  /**
   * O destinatário recusa comunicações: fica `OPTED_OUT` nesta campanha, a lead passa a `OPT_OUT` e o seu email e
   * telefone entram na lista de exclusão, para nunca mais receber comunicação promocional de qualquer campanha.
   */
  optOut(context: TenantContext, id: string, memberId: string): Promise<CampaignMember> {
    return this.uow.run(async (scope) => {
      const member = await this.campaigns.findMember(scope, id, memberId)
      if (!member) throw ApiError.notFound()
      const values: { kind: ExclusionKind; value: string | null }[] = []
      if (member.leadId) {
        const lead = await this.leads.find(scope, member.leadId, true)
        if (lead) {
          if (lead.consentStatus !== 'OPT_OUT') {
            await this.leads.update(scope, lead.id, lead.version, {
              name: lead.name,
              companyName: lead.companyName,
              email: lead.email,
              phone: lead.phone,
              source: lead.source,
              consentStatus: 'OPT_OUT',
              ownerMembershipId: lead.ownerMembershipId,
            })
          }
          values.push({ kind: 'EMAIL', value: lead.email }, { kind: 'PHONE', value: lead.phone })
        }
      }
      if (member.partyId) {
        values.push(
          {
            kind: 'EMAIL',
            value: await this.references.partyDestination(context, member.partyId, 'EMAIL'),
          },
          {
            kind: 'PHONE',
            value: await this.references.partyDestination(context, member.partyId, 'PHONE'),
          }
        )
      }
      for (const entry of values) {
        const normalized = entry.value ? exclusionValue(entry.kind, entry.value) : null
        if (normalized) {
          await this.exclusions.insert(scope, {
            kind: entry.kind,
            value: normalized,
            reason: 'Recusou comunicações promocionais',
          })
        }
      }
      return member.status === 'OPTED_OUT'
        ? member
        : this.campaigns.setMemberStatus(scope, memberId, 'OPTED_OUT')
    }, context)
  }

  /**
   * Pede o envio aos destinatários ainda por contactar. Nunca contacta quem recusou (consentimento da lead ou lista de
   * exclusão: passam a `OPTED_OUT`); uma lead sem consentimento expresso e quem não tem destino para o canal ficam por
   * contactar. Cada envio é um evento do outbox para o serviço de notificações, e só os destinatários `TARGETED` são
   * tocados: repetir não volta a contactar ninguém.
   */
  send(context: TenantContext, id: string): Promise<SendResult> {
    return this.uow.run(async (scope) => {
      const campaign = await this.campaigns.find(scope, id, true)
      if (!campaign) throw ApiError.notFound()
      const now = this.clock.now().getTime()
      if (
        campaign.status !== 'ACTIVE' ||
        Date.parse(campaign.startsAt) > now ||
        (campaign.endsAt !== null && Date.parse(campaign.endsAt) < now)
      ) {
        throw ApiError.conflict(
          'CAMPAIGN_NOT_RUNNING',
          'Só se envia uma campanha activa, dentro do seu período.'
        )
      }
      const kind = destinationKind(campaign.channel)
      const targets = await this.campaigns.membersToSend(scope, id)
      const destinations = new Map<string, string | null>()
      for (const t of targets) {
        let destination: string | null
        if (kind === null) destination = 'n/a'
        else if (t.leadId) destination = kind === 'EMAIL' ? t.leadEmail : t.leadPhone
        else
          destination = await this.references.partyDestination(context, t.partyId as string, kind)
        destinations.set(
          t.memberId,
          destination && kind !== null ? exclusionValue(kind, destination) : destination
        )
      }
      const excluded =
        kind === null
          ? new Set<string>()
          : await this.exclusions.excluded(
              scope,
              kind,
              [...destinations.values()].filter((v): v is string => v !== null)
            )
      const result: SendResult = { sent: 0, optedOut: 0, noConsent: 0, noDestination: 0 }
      for (const t of targets) {
        const destination = destinations.get(t.memberId) ?? null
        const decision = sendDecision({
          leadConsent: t.leadId ? t.leadConsent : null,
          destination,
          excluded: destination !== null && excluded.has(destination),
        })
        if (decision === 'SEND') {
          await this.campaigns.setMemberStatus(scope, t.memberId, 'CONTACTED')
          await this.outbox.append(scope, {
            aggregateType: 'campaign_member',
            aggregateId: t.memberId,
            aggregateVersion: 1,
            eventType: 'crm.campaign.contact_requested',
            payload: { campaignId: id, memberId: t.memberId, channel: campaign.channel },
            correlationId: context.correlationId,
          })
          result.sent++
        } else if (decision === 'OPTED_OUT') {
          await this.campaigns.setMemberStatus(scope, t.memberId, 'OPTED_OUT')
          result.optedOut++
        } else if (decision === 'NO_CONSENT') result.noConsent++
        else result.noDestination++
      }
      return result
    }, context)
  }
}

// --- lista de exclusão ------------------------------------------------------------------------------

export class ExclusionUseCases {
  constructor(
    private readonly uow: TenantUnitOfWork,
    private readonly exclusions: ExclusionStore
  ) {}

  list(context: TenantContext, filter: { limit?: number; offset?: number }) {
    const { limit, offset } = page(filter)
    return this.uow.run((scope) => this.exclusions.list(scope, limit, offset), context)
  }

  add(
    context: TenantContext,
    input: { kind?: unknown; value?: unknown; reason?: unknown }
  ): Promise<Exclusion> {
    const kind = input.kind === 'EMAIL' || input.kind === 'PHONE' ? input.kind : null
    if (!kind) throw failure('kind', 'INVALID', 'Tipo: EMAIL ou PHONE.')
    const value = typeof input.value === 'string' ? exclusionValue(kind, input.value) : null
    if (!value) throw failure('value', 'INVALID', 'Valor inválido para o tipo escolhido.')
    const reason =
      typeof input.reason === 'string' && input.reason.trim()
        ? input.reason.trim().slice(0, 300)
        : null
    return this.uow.run(async (scope) => {
      const created = await this.exclusions.insert(scope, { kind, value, reason })
      if (!created) {
        throw ApiError.conflict('EXCLUSION_EXISTS', 'Este valor já está na lista de exclusão.')
      }
      return created
    }, context)
  }

  remove(context: TenantContext, id: string): Promise<void> {
    return this.uow.run(async (scope) => {
      if (!(await this.exclusions.remove(scope, id))) throw ApiError.notFound()
    }, context)
  }
}
