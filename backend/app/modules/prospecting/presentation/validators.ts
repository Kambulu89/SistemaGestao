import vine from '@vinejs/vine'

const version = () => vine.number().withoutDecimals().min(1)
const uuid = () => vine.string().trim().uuid()
const page = {
  limit: vine.number().withoutDecimals().min(1).max(200).optional(),
  offset: vine.number().withoutDecimals().min(0).optional(),
}

/** O conteúdo (nomes, valores, datas, regras) é validado pelo domínio; aqui só o transporte. */
export const reasonValidator = vine.compile(
  vine.object({ reason: vine.string().trim().maxLength(300) })
)

// --- etapas -------------------------------------------------------------------------------------

export const listStagesValidator = vine.compile(
  vine.object({
    pipelineCode: vine.string().trim().maxLength(40).optional(),
    activeOnly: vine.boolean().optional(),
  })
)

const stageBody = {
  name: vine.string().trim().maxLength(120).optional(),
  position: vine.number().withoutDecimals().optional(),
  probability: vine.string().trim().maxLength(10).optional(),
  requiresEvidence: vine.boolean().optional(),
  active: vine.boolean().optional(),
}
export const createStageValidator = vine.compile(
  vine.object({
    pipelineCode: vine.string().trim().maxLength(40).optional(),
    code: vine.string().trim().maxLength(40),
    outcome: vine.string().trim().maxLength(4).nullable().optional(),
    ...stageBody,
  })
)
export const updateStageValidator = vine.compile(
  vine.object({
    expectedVersion: version(),
    // Presente só para o domínio o recusar com uma mensagem clara (imutável).
    outcome: vine.string().trim().maxLength(4).nullable().optional(),
    ...stageBody,
  })
)

// --- leads --------------------------------------------------------------------------------------

export const listLeadsValidator = vine.compile(
  vine.object({
    q: vine.string().trim().maxLength(100).optional(),
    status: vine.enum(['NEW', 'QUALIFIED', 'DISQUALIFIED', 'CONVERTED']).optional(),
    ownerMembershipId: uuid().optional(),
    consentStatus: vine.enum(['UNKNOWN', 'OPT_IN', 'OPT_OUT']).optional(),
    ...page,
  })
)

const leadBody = {
  companyName: vine.string().maxLength(160).nullable().optional(),
  email: vine.string().maxLength(200).nullable().optional(),
  phone: vine.string().maxLength(40).nullable().optional(),
  consentStatus: vine.string().trim().maxLength(10).optional(),
  ownerMembershipId: uuid().optional(),
}
export const createLeadValidator = vine.compile(
  vine.object({
    name: vine.string().trim().maxLength(160),
    source: vine.string().trim().maxLength(60),
    ...leadBody,
  })
)
export const updateLeadValidator = vine.compile(
  vine.object({
    expectedVersion: version(),
    name: vine.string().trim().maxLength(160).optional(),
    source: vine.string().trim().maxLength(60).optional(),
    ...leadBody,
  })
)
export const convertLeadValidator = vine.compile(
  vine.object({
    organizationId: uuid(),
    partyId: uuid().optional(),
    customerCode: vine.string().trim().maxLength(40).optional(),
    opportunity: vine
      .object({
        name: vine.string().trim().maxLength(200).optional(),
        stageId: uuid().optional(),
        expectedValue: vine.string().trim().maxLength(30).optional(),
        currency: vine.string().trim().maxLength(3).optional(),
        expectedCloseDate: vine.string().trim().maxLength(10).nullable().optional(),
      })
      .optional(),
  })
)

// --- oportunidades ------------------------------------------------------------------------------

export const listOpportunitiesValidator = vine.compile(
  vine.object({
    stageId: uuid().optional(),
    ownerMembershipId: uuid().optional(),
    customerId: uuid().optional(),
    leadId: uuid().optional(),
    status: vine.enum(['open', 'won', 'lost']).optional(),
    q: vine.string().trim().maxLength(100).optional(),
    ...page,
  })
)
const opportunityBody = {
  name: vine.string().trim().maxLength(200).optional(),
  expectedValue: vine.string().trim().maxLength(30).optional(),
  currency: vine.string().trim().maxLength(3).optional(),
  expectedCloseDate: vine.string().trim().maxLength(10).nullable().optional(),
}
export const createOpportunityValidator = vine.compile(
  vine.object({
    organizationId: uuid().optional(),
    customerId: uuid().optional(),
    leadId: uuid().optional(),
    stageId: uuid().optional(),
    ownerMembershipId: uuid().optional(),
    ...opportunityBody,
    name: vine.string().trim().maxLength(200),
  })
)
export const updateOpportunityValidator = vine.compile(
  vine.object({ expectedVersion: version(), ...opportunityBody })
)
export const moveOpportunityValidator = vine.compile(
  vine.object({
    stageId: uuid(),
    expectedVersion: version().optional(),
    lossReason: vine.string().maxLength(1000).nullable().optional(),
    winEvidence: vine.string().maxLength(2000).nullable().optional(),
  })
)
export const metricsValidator = vine.compile(
  vine.object({
    from: vine.string().trim().maxLength(10).optional(),
    to: vine.string().trim().maxLength(10).optional(),
  })
)
export const activityValidator = vine.compile(
  vine.object({
    kind: vine.string().trim().maxLength(8),
    subject: vine.string().trim().maxLength(200),
    notes: vine.string().maxLength(4000).nullable().optional(),
    dueAt: vine.string().trim().maxLength(40).nullable().optional(),
  })
)

// --- campanhas ----------------------------------------------------------------------------------

export const listCampaignsValidator = vine.compile(
  vine.object({
    status: vine.enum(['DRAFT', 'ACTIVE', 'PAUSED', 'COMPLETED']).optional(),
    channel: vine.enum(['EMAIL', 'SMS', 'WHATSAPP', 'CALL', 'EVENT', 'OTHER']).optional(),
    ...page,
  })
)
const campaignBody = {
  subject: vine.string().maxLength(200).nullable().optional(),
  message: vine.string().maxLength(4000).nullable().optional(),
  startsAt: vine.string().trim().maxLength(40).optional(),
  endsAt: vine.string().trim().maxLength(40).nullable().optional(),
  budget: vine.string().trim().maxLength(30).optional(),
  currency: vine.string().trim().maxLength(3).optional(),
}
export const createCampaignValidator = vine.compile(
  vine.object({
    organizationId: uuid().optional(),
    name: vine.string().trim().maxLength(160),
    channel: vine.string().trim().maxLength(10),
    ...campaignBody,
  })
)
export const updateCampaignValidator = vine.compile(
  vine.object({
    expectedVersion: version(),
    name: vine.string().trim().maxLength(160).optional(),
    channel: vine.string().trim().maxLength(10).optional(),
    ...campaignBody,
  })
)
export const campaignStatusValidator = vine.compile(
  vine.object({ status: vine.enum(['DRAFT', 'ACTIVE', 'PAUSED', 'COMPLETED']) })
)
export const listMembersValidator = vine.compile(
  vine.object({
    status: vine.enum(['TARGETED', 'CONTACTED', 'RESPONDED', 'OPTED_OUT']).optional(),
    ...page,
  })
)
export const addMembersValidator = vine.compile(
  vine.object({
    partyIds: vine.array(uuid()).maxLength(500).optional(),
    leadIds: vine.array(uuid()).maxLength(500).optional(),
  })
)

// --- lista de exclusão --------------------------------------------------------------------------

export const pageValidator = vine.compile(vine.object({ ...page }))
export const addExclusionValidator = vine.compile(
  vine.object({
    kind: vine.string().trim().maxLength(5),
    value: vine.string().trim().maxLength(200),
    reason: vine.string().maxLength(300).nullable().optional(),
  })
)
