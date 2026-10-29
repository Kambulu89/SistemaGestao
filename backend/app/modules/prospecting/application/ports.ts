import type { TenantContext, TenantScope } from '#core/tenancy/index'
import type {
  ActivityKind,
  ActivityValues,
  CampaignChannel,
  CampaignStatus,
  CampaignValues,
  ConsentStatus,
  ExclusionKind,
  LeadStatus,
  LeadValues,
  MemberStatus,
  OpportunityValues,
  StageOutcome,
  StageValues,
} from '#modules/prospecting/domain/prospecting'

interface Audited {
  id: string
  version: number
  createdAt: Date
  updatedAt: Date
}

// --- etapas -----------------------------------------------------------------------------------------

export interface Stage extends Audited, StageValues {}

export interface StageStore {
  list(scope: TenantScope, pipelineCode: string, activeOnly: boolean): Promise<Stage[]>
  find(scope: TenantScope, id: string): Promise<Stage | null>
  /** Insere as etapas que faltam por código (idempotente: o que já existe fica como está). */
  insertMissing(scope: TenantScope, values: readonly StageValues[]): Promise<void>
  insert(scope: TenantScope, values: StageValues): Promise<Stage | 'CODE'>
  update(
    scope: TenantScope,
    id: string,
    expectedVersion: number,
    values: StageValues
  ): Promise<Stage>
  /** Oportunidades abertas nesta etapa (impede desactivá-la). */
  openCount(scope: TenantScope, stageId: string): Promise<number>
}

// --- leads ------------------------------------------------------------------------------------------

export interface Lead extends Audited, LeadValues {
  ownerMembershipId: string
  status: LeadStatus
  disqualifyReason: string | null
  partyId: string | null
  customerId: string | null
  opportunityId: string | null
  convertedAt: Date | null
}

export interface LeadFilter {
  q?: string
  status?: LeadStatus
  ownerMembershipId?: string
  consentStatus?: ConsentStatus
  limit: number
  offset: number
}

export interface LeadStore {
  list(scope: TenantScope, filter: LeadFilter): Promise<{ items: Lead[]; total: number }>
  find(scope: TenantScope, id: string, lock?: boolean): Promise<Lead | null>
  insert(scope: TenantScope, values: LeadValues & { ownerMembershipId: string }): Promise<Lead>
  update(
    scope: TenantScope,
    id: string,
    expectedVersion: number,
    values: LeadValues & { ownerMembershipId: string }
  ): Promise<Lead>
  setStatus(
    scope: TenantScope,
    id: string,
    patch: { status: 'QUALIFIED' } | { status: 'DISQUALIFIED'; reason: string } | { status: 'NEW' }
  ): Promise<Lead>
  /** Grava o resultado da conversão (identificadores) e passa a lead a `CONVERTED`. */
  markConverted(
    scope: TenantScope,
    id: string,
    result: { partyId: string; customerId: string; opportunityId: string | null }
  ): Promise<Lead>
}

// --- oportunidades ----------------------------------------------------------------------------------

export interface Opportunity extends Audited, Omit<OpportunityValues, 'stageId'> {
  ownerMembershipId: string
  stageId: string
  stageCode: string
  stageName: string
  probability: string
  outcome: StageOutcome | null
  lossReason: string | null
  winEvidence: string | null
  closedAt: Date | null
  customerName: string | null
  leadName: string | null
}

export interface OpportunityFilter {
  stageId?: string
  ownerMembershipId?: string
  customerId?: string
  leadId?: string
  /** `open`, `won` ou `lost`, pelo desfecho da etapa actual. */
  status?: 'open' | 'won' | 'lost'
  q?: string
  limit: number
  offset: number
}

export interface StageMove {
  id: string
  opportunityId: string
  fromStageId: string | null
  toStageId: string
  movedAt: Date
  movedByMembershipId: string | null
}

export interface OpportunityMetrics {
  from: string
  to: string
  /** Oportunidades que **entraram** em cada etapa no período, pelas datas das transições. */
  entered: { stageId: string; code: string; name: string; count: number }[]
  won: number
  lost: number
  /** Ganhas / (ganhas + perdidas) fechadas no período, em texto decimal; `null` sem nenhuma fechada. */
  winRate: string | null
  /** Valor esperado das ganhas e dos negócios em aberto, por moeda. */
  wonValue: { currency: string; value: string }[]
  openValue: { currency: string; value: string }[]
  /** Dias médios entre criar e ganhar, das ganhas no período; `null` sem nenhuma. */
  averageDaysToWin: string | null
}

export interface OpportunityStore {
  list(
    scope: TenantScope,
    filter: OpportunityFilter
  ): Promise<{ items: Opportunity[]; total: number }>
  find(scope: TenantScope, id: string, lock?: boolean): Promise<Opportunity | null>
  insert(
    scope: TenantScope,
    values: OpportunityValues & { stageId: string; ownerMembershipId: string }
  ): Promise<Opportunity>
  update(
    scope: TenantScope,
    id: string,
    expectedVersion: number,
    values: OpportunityValues & { stageId: string }
  ): Promise<Opportunity>
  moveTo(
    scope: TenantScope,
    id: string,
    patch: {
      stageId: string
      closed: boolean
      lossReason: string | null
      winEvidence: string | null
    }
  ): Promise<Opportunity>
  insertMove(
    scope: TenantScope,
    values: { opportunityId: string; fromStageId: string | null; toStageId: string }
  ): Promise<void>
  history(scope: TenantScope, opportunityId: string): Promise<StageMove[]>
  metrics(scope: TenantScope, from: string, to: string): Promise<OpportunityMetrics>
}

// --- actividades ------------------------------------------------------------------------------------

export interface Activity extends Audited, ActivityValues {
  opportunityId: string
  ownerMembershipId: string
  doneAt: Date | null
}

export interface ActivityStore {
  list(scope: TenantScope, opportunityId: string): Promise<Activity[]>
  find(scope: TenantScope, id: string): Promise<Activity | null>
  insert(
    scope: TenantScope,
    opportunityId: string,
    ownerMembershipId: string,
    values: ActivityValues
  ): Promise<Activity>
  complete(scope: TenantScope, id: string): Promise<Activity>
}

// --- campanhas --------------------------------------------------------------------------------------

export interface Campaign extends Audited, CampaignValues {
  status: CampaignStatus
}

export interface CampaignMember {
  id: string
  campaignId: string
  partyId: string | null
  leadId: string | null
  partyName: string | null
  leadName: string | null
  status: MemberStatus
  contactedAt: Date | null
  respondedAt: Date | null
}

export interface CampaignSummary {
  total: number
  targeted: number
  contacted: number
  responded: number
  optedOut: number
}

export interface CampaignFilter {
  status?: CampaignStatus
  channel?: CampaignChannel
  limit: number
  offset: number
}

export interface CampaignStore {
  list(
    scope: TenantScope,
    filter: CampaignFilter
  ): Promise<{ items: (Campaign & { summary: CampaignSummary })[]; total: number }>
  find(scope: TenantScope, id: string, lock?: boolean): Promise<Campaign | null>
  insert(scope: TenantScope, values: CampaignValues): Promise<Campaign>
  update(
    scope: TenantScope,
    id: string,
    expectedVersion: number,
    values: CampaignValues
  ): Promise<Campaign>
  setStatus(scope: TenantScope, id: string, status: CampaignStatus): Promise<Campaign>
  summary(scope: TenantScope, id: string): Promise<CampaignSummary>
  members(
    scope: TenantScope,
    campaignId: string,
    status: MemberStatus | undefined,
    limit: number,
    offset: number
  ): Promise<{ items: CampaignMember[]; total: number }>
  /** Todos os membros num dado estado, para o envio (com os dados do destinatário). */
  membersToSend(scope: TenantScope, campaignId: string): Promise<SendTarget[]>
  /** Devolve `false` se o destinatário já é membro desta campanha. */
  addMember(
    scope: TenantScope,
    campaignId: string,
    target: { partyId: string } | { leadId: string }
  ): Promise<CampaignMember | null>
  findMember(
    scope: TenantScope,
    campaignId: string,
    memberId: string
  ): Promise<CampaignMember | null>
  removeMember(scope: TenantScope, campaignId: string, memberId: string): Promise<boolean>
  setMemberStatus(
    scope: TenantScope,
    memberId: string,
    status: MemberStatus
  ): Promise<CampaignMember>
}

export interface SendTarget {
  memberId: string
  partyId: string | null
  leadId: string | null
  leadEmail: string | null
  leadPhone: string | null
  leadConsent: ConsentStatus | null
}

// --- exclusões --------------------------------------------------------------------------------------

export interface Exclusion {
  id: string
  kind: ExclusionKind
  value: string
  reason: string | null
  createdAt: Date
}

export interface ExclusionStore {
  list(
    scope: TenantScope,
    limit: number,
    offset: number
  ): Promise<{ items: Exclusion[]; total: number }>
  /** `null` se já existia. */
  insert(
    scope: TenantScope,
    values: { kind: ExclusionKind; value: string; reason: string | null }
  ): Promise<Exclusion | null>
  remove(scope: TenantScope, id: string): Promise<boolean>
  /** Quais dos valores estão na lista. */
  excluded(scope: TenantScope, kind: ExclusionKind, values: readonly string[]): Promise<Set<string>>
}

// --- referências a outros módulos -------------------------------------------------------------------

export interface PartyRef {
  id: string
  displayName: string
}

export interface CustomerRef {
  id: string
  partyId: string
  organizationId: string
  currency: string
}

export interface PartyInput {
  kind: 'PERSON' | 'ORGANIZATION'
  displayName: string
  givenNames?: string
  familyName?: string
  legalName?: string
  email: string | null
  phone: string | null
}

export interface References {
  organizationCurrency(context: TenantContext, organizationId: string): Promise<string | null>
  membershipActive(scope: TenantScope, membershipId: string): Promise<boolean>
  partyExists(context: TenantContext, partyId: string): Promise<boolean>
  customer(context: TenantContext, customerId: string): Promise<CustomerRef | null>
  /** Uma Party já existente com este email de contacto (se for única); senão `null`. */
  partyByEmail(context: TenantContext, email: string): Promise<PartyRef | null>
  createParty(context: TenantContext, input: PartyInput): Promise<PartyRef>
  /** O cliente da Party nesta organização, se já existe. */
  customerOfParty(
    context: TenantContext,
    partyId: string,
    organizationId: string
  ): Promise<CustomerRef | null>
  createCustomer(
    context: TenantContext,
    input: {
      partyId: string
      organizationId: string
      code: string
      accountManagerMembershipId: string
    }
  ): Promise<CustomerRef>
  /** Email ou telefone principal da Party para o canal; `null` se não tem. */
  partyDestination(
    context: TenantContext,
    partyId: string,
    kind: ExclusionKind
  ): Promise<string | null>
}

export type { ActivityKind }
