import { ApiError, type ErrorDetail } from '#shared/http/api_error'
import { constraintOf, isUuid } from '#shared/db/sql'
import { runInTenant, type TenantContext, type TenantScope } from '#modules/tenancy/index'
import { audit } from '#modules/audit/index'
import { permissionScope, type PermissionScope } from '#modules/rbac/index'
import { submitForSubject, type ApprovalOutcome } from '#modules/approvals/index'
import { covers, findRow, placementOf, scopeClause } from '#modules/hr/application/employee_service'
import { contractTermsAt } from '#modules/hr/application/career_service'
import { hrSettings } from '#modules/hr/application/recruitment_service'
import { normalizeFields } from '#modules/hr/domain/recruitment'
import { previousDay } from '#modules/hr/domain/contracts'
import {
  componentIssues,
  lineIssues,
  PAY_CALCULATIONS,
  PAY_CATEGORIES,
  PAY_KINDS,
  type PayCalculation,
  percentOf,
} from '#modules/hr/domain/compensation'

/*
 * Compensação e benefícios (7.5). Catálogo e incidências: `hr.compensation.settings` (rota). Por colaborador (no âmbito
 * da sua colocação, como os contratos): ver `hr.compensation.read` (o próprio com OWN), propor
 * `hr.compensation.manage`, aprovar `hr.compensation.approve` sem ser quem preparou, ou o workflow configurado. Os
 * valores nunca vão para a auditoria.
 */

const RESERVED = '[RESERVADO]'
const noOwn = (s: PermissionScope): PermissionScope => ({ ...s, own: false })
const fail = (issues: ErrorDetail[]) => {
  if (issues.length) throw ApiError.validation(issues)
}
const wrongState = (message: string): never => {
  throw ApiError.conflict('INVALID_STATE', message)
}

// ---------------------------------------------------------------------------------------------------------------
// Catálogo e incidências
// ---------------------------------------------------------------------------------------------------------------

function componentView(c: any) {
  return {
    id: c.id as string,
    version: Number(c.version),
    code: c.code as string,
    name: c.name as string,
    kind: c.kind as string,
    category: c.category as string,
    calculation: c.calculation as PayCalculation,
    recurring: Boolean(c.recurring),
    status: c.status as string,
  }
}

function incidenceView(i: any) {
  return {
    id: i.id as string,
    validFrom: i.from_text as string,
    irtSubject: Boolean(i.irt_subject),
    irtExemptAmount: (i.irt_exempt_amount as string) ?? null,
    inssSubject: Boolean(i.inss_subject),
    legalReference: i.legal_reference as string,
    createdAt: i.created_at,
  }
}

const COMPONENT_COLUMNS: Record<string, string> = {
  code: 'code',
  name: 'name',
  kind: 'kind',
  category: 'category',
  calculation: 'calculation',
  recurring: 'recurring',
  status: 'status',
}

function componentValues(input: Record<string, unknown>, creating: boolean) {
  const { values: v, issues } = normalizeFields(input, {
    code: { kind: 'code', label: 'Código' },
    name: { kind: 'text', min: 2, max: 120, label: 'Nome' },
  })
  const out: Record<string, unknown> = { ...v }
  const pick = (key: string, list: readonly string[], label: string) => {
    if (!(key in input)) {
      if (creating) issues.push({ path: key, code: 'REQUIRED', message: 'Obrigatório.' })
      return
    }
    if (!list.includes(input[key] as string))
      issues.push({ path: key, code: 'INVALID', message: `${label} inválido(a).` })
    else out[key] = input[key]
  }
  pick('kind', PAY_KINDS, 'Natureza')
  pick('category', PAY_CATEGORIES, 'Categoria')
  pick('calculation', PAY_CALCULATIONS, 'Cálculo')
  if ('recurring' in input) {
    if (typeof input.recurring !== 'boolean')
      issues.push({ path: 'recurring', code: 'INVALID', message: 'Sim ou não.' })
    else out.recurring = input.recurring
  }
  if ('status' in input) {
    if (!['ACTIVE', 'INACTIVE'].includes(input.status as string))
      issues.push({ path: 'status', code: 'INVALID', message: 'Activo ou inactivo.' })
    else out.status = input.status
  }
  if (creating)
    for (const k of ['code', 'name'])
      if (!out[k]) issues.push({ path: k, code: 'REQUIRED', message: 'Obrigatório.' })
  return { values: out, issues }
}

async function incidencesOf(scope: TenantScope, componentId: string) {
  const r = await scope.trx.rawQuery(
    `select *, valid_from::text as from_text from pay_component_incidences
      where tenant_id = ? and component_id = ? order by valid_from desc`,
    [scope.context.tenantId, componentId]
  )
  return (r.rows as any[]).map(incidenceView)
}

async function findComponent(scope: TenantScope, id: string, lock = false) {
  if (!isUuid(id)) return null
  const r = await scope.trx.rawQuery(
    `select * from pay_components where tenant_id = ? and id = ?${lock ? ' for update' : ''}`,
    [scope.context.tenantId, id]
  )
  return (r.rows[0] as any) ?? null
}

const anyScope = (p: PermissionScope) =>
  p.tenant || p.own || p.legalEntityIds.size > 0 || p.branchIds.size > 0 || p.departmentIds.size > 0

export class PayComponentService {
  /** Catálogo (sem valores de ninguém): para quem configura e para quem vê, propõe ou aprova compensação. */
  list(context: TenantContext) {
    return runInTenant(context, async (scope) => {
      const perms = await Promise.all(
        [
          'hr.compensation.settings',
          'hr.compensation.read',
          'hr.compensation.manage',
          'hr.compensation.approve',
        ].map((p) => permissionScope(scope, p))
      )
      if (!perms.some(anyScope))
        throw ApiError.forbidden('FORBIDDEN', 'Não tem acesso à compensação.')
      const r = await scope.trx.rawQuery(
        `select c.*, inc.irt_subject as irt_now, inc.inss_subject as inss_now, inc.irt_exempt_amount as exempt_now
           from pay_components c
           left join lateral (select i.irt_subject, i.inss_subject, i.irt_exempt_amount from pay_component_incidences i
             where i.tenant_id = c.tenant_id and i.component_id = c.id and i.valid_from <= current_date
             order by i.valid_from desc limit 1) inc on true
          where c.tenant_id = ? order by c.kind, c.name`,
        [context.tenantId]
      )
      return (r.rows as any[]).map((c) => ({
        ...componentView(c),
        currentIncidence:
          c.irt_now === null || c.irt_now === undefined
            ? null
            : {
                irtSubject: Boolean(c.irt_now),
                inssSubject: Boolean(c.inss_now),
                irtExemptAmount: (c.exempt_now as string) ?? null,
              },
      }))
    })
  }

  get(context: TenantContext, id: string) {
    return runInTenant(context, async (scope) => {
      const c = await findComponent(scope, id)
      if (!c) throw ApiError.notFound()
      return { ...componentView(c), incidences: await incidencesOf(scope, id) }
    })
  }

  create(context: TenantContext, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const { values: v, issues } = componentValues(input, true)
      issues.push(...componentIssues(v))
      fail(issues)
      const keys = Object.keys(v)
      let id: string
      try {
        const r = await scope.trx.rawQuery(
          `insert into pay_components (tenant_id, created_by, updated_by, ${keys.map((k) => COMPONENT_COLUMNS[k]).join(', ')})
           values (?, ?, ?, ${keys.map(() => '?').join(', ')}) returning id`,
          [context.tenantId, context.userId, context.userId, ...keys.map((k) => v[k])] as never[]
        )
        id = (r.rows[0] as { id: string }).id
      } catch (error) {
        codeTaken(error)
      }
      await audit(scope, {
        action: 'hr.pay_component.created',
        entityType: 'pay_component',
        entityId: id,
        changes: Object.fromEntries(keys.map((k) => [k, { from: null, to: v[k] }])),
      })
      return { ...componentView(await findComponent(scope, id)), incidences: [] }
    })
  }

  /** Nome, recorrência e estado mudam sempre; natureza, categoria e cálculo só antes de haver propostas. */
  update(
    context: TenantContext,
    id: string,
    input: Record<string, unknown>,
    expectedVersion: number
  ) {
    return runInTenant(context, async (scope) => {
      const c = await findComponent(scope, id, true)
      if (!c) throw ApiError.notFound()
      if (Number(c.version) !== expectedVersion) throw ApiError.versionConflict(Number(c.version))
      const { values: v, issues } = componentValues(input, false)
      const before = componentView(c) as Record<string, unknown>
      const after = { ...before, ...v }
      issues.push(...componentIssues(after))
      const used = await scope.trx.rawQuery(
        `select 1 from compensation_proposal_lines where tenant_id = ? and component_id = ? limit 1`,
        [context.tenantId, id]
      )
      if (used.rows.length)
        for (const k of ['kind', 'category', 'calculation', 'code'])
          if (k in v && v[k] !== before[k])
            issues.push({
              path: k,
              code: 'IN_USE',
              message: 'Já usado em propostas: crie outro componente.',
            })
      fail(issues)
      const changed = Object.keys(v).filter((k) => before[k] !== v[k])
      if (changed.length) {
        try {
          await scope.trx.rawQuery(
            `update pay_components set ${changed.map((k) => `${COMPONENT_COLUMNS[k]} = ?`).join(', ')},
               version = version + 1, updated_by = ?, updated_at = now() where tenant_id = ? and id = ?`,
            [...changed.map((k) => v[k]), context.userId, context.tenantId, id] as never[]
          )
        } catch (error) {
          codeTaken(error)
        }
        await audit(scope, {
          action: 'hr.pay_component.updated',
          entityType: 'pay_component',
          entityId: id,
          changes: Object.fromEntries(changed.map((k) => [k, { from: before[k], to: v[k] }])),
        })
      }
      return {
        ...componentView(await findComponent(scope, id)),
        incidences: await incidencesOf(scope, id),
      }
    })
  }

  /** Nova versão da incidência de IRT/INSS a partir de uma data (posterior à última); nunca altera as anteriores. */
  addIncidence(context: TenantContext, id: string, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const c = await findComponent(scope, id, true)
      if (!c) throw ApiError.notFound()
      const { values: v, issues } = normalizeFields(input, {
        validFrom: { kind: 'date', label: 'Em vigor desde' },
        irtExemptAmount: { kind: 'money', label: 'Parte isenta de IRT' },
        legalReference: { kind: 'longtext', min: 5, max: 2000, label: 'Fonte legal' },
      })
      for (const k of ['irtSubject', 'inssSubject'])
        if (typeof input[k] !== 'boolean')
          issues.push({ path: k, code: 'REQUIRED', message: 'Indique sim ou não.' })
      for (const k of ['validFrom', 'legalReference'])
        if (!v[k]) issues.push({ path: k, code: 'REQUIRED', message: 'Obrigatório.' })
      if (v.irtExemptAmount && input.irtSubject !== true)
        issues.push({
          path: 'irtExemptAmount',
          code: 'INVALID',
          message: 'A parte isenta só se aplica a componentes sujeitos a IRT.',
        })
      if (c.kind === 'DEDUCTION' && (input.irtSubject === true || input.inssSubject === true))
        issues.push({
          path: 'irtSubject',
          code: 'INVALID',
          message: 'Um desconto não é rendimento sujeito: a dedução é tratada no processamento.',
        })
      fail(issues)
      const last = await scope.trx.rawQuery(
        `select max(valid_from)::text as d from pay_component_incidences where tenant_id = ? and component_id = ?`,
        [context.tenantId, id]
      )
      const lastFrom = (last.rows[0] as { d: string | null }).d
      if (lastFrom && (v.validFrom as string) <= lastFrom)
        fail([
          {
            path: 'validFrom',
            code: 'NOT_AFTER_PREVIOUS',
            message: `Tem de começar depois da versão actual (${lastFrom}).`,
          },
        ])
      const r = await scope.trx.rawQuery(
        `insert into pay_component_incidences (tenant_id, component_id, valid_from, irt_subject, irt_exempt_amount,
           inss_subject, legal_reference, created_by, updated_by) values (?, ?, ?, ?, ?, ?, ?, ?, ?) returning id`,
        [
          context.tenantId,
          id,
          v.validFrom,
          input.irtSubject,
          v.irtExemptAmount ?? null,
          input.inssSubject,
          v.legalReference,
          context.userId,
          context.userId,
        ] as never[]
      )
      await audit(scope, {
        action: 'hr.pay_component.incidence_added',
        entityType: 'pay_component',
        entityId: id,
        metadata: {
          incidenceId: (r.rows[0] as { id: string }).id,
          validFrom: v.validFrom,
          irtSubject: input.irtSubject,
          inssSubject: input.inssSubject,
          irtExemptAmount: v.irtExemptAmount ?? null,
        },
      })
      return { ...componentView(c), incidences: await incidencesOf(scope, id) }
    })
  }
}

function codeTaken(error: unknown): never {
  if (constraintOf(error) === 'pay_components_code_unique')
    throw new ApiError(409, 'CODE_TAKEN', 'Já existe um componente com este código.', [
      { path: 'code', code: 'CODE_TAKEN', message: 'Já existe um componente com este código.' },
    ])
  throw error
}

// ---------------------------------------------------------------------------------------------------------------
// Compensação do colaborador numa data (para o processamento salarial)
// ---------------------------------------------------------------------------------------------------------------

/**
 * Remuneração em vigor numa data: o salário base do contrato e os componentes em vigor, com a incidência de IRT/INSS
 * dessa data e as percentagens convertidas em montante sobre o salário base. `null` se não há contrato a cobrir a data.
 */
export async function compensationAt(scope: TenantScope, employeeId: string, date: string) {
  const terms = await contractTermsAt(scope, employeeId, date)
  if (!terms) return null
  const r = await scope.trx.rawQuery(
    `select p.*, p.valid_from::text as from_text, p.valid_to::text as to_text, c.code, c.name, c.kind, c.category,
        c.calculation, inc.irt_subject, inc.irt_exempt_amount, inc.inss_subject, inc.valid_from::text as inc_from
       from employee_pay_items p
       join pay_components c on c.tenant_id = p.tenant_id and c.id = p.component_id
       left join lateral (select * from pay_component_incidences i where i.tenant_id = p.tenant_id
         and i.component_id = p.component_id and i.valid_from <= ?::date order by i.valid_from desc limit 1) inc on true
      where p.tenant_id = ? and p.employee_id = ? and p.valid_from <= ?::date
        and (p.valid_to is null or p.valid_to >= ?::date)
      order by c.kind, c.name`,
    [date, scope.context.tenantId, employeeId, date, date]
  )
  return {
    date,
    contractId: terms.contractId,
    currency: terms.currency,
    baseSalary: terms.baseSalary,
    lines: (r.rows as any[]).map((x) => ({
      componentId: x.component_id as string,
      code: x.code as string,
      name: x.name as string,
      kind: x.kind as string,
      category: x.category as string,
      amount: x.amount ?? percentOf(terms.baseSalary, x.percent),
      percent: (x.percent as string) ?? null,
      // Sem incidência definida, o processamento não pode assumir nada: fica `null` e terá de ser resolvido.
      incidence:
        x.irt_subject === null || x.irt_subject === undefined
          ? null
          : {
              validFrom: x.inc_from as string,
              irtSubject: Boolean(x.irt_subject),
              irtExemptAmount: (x.irt_exempt_amount as string) ?? null,
              inssSubject: Boolean(x.inss_subject),
            },
    })),
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Propostas
// ---------------------------------------------------------------------------------------------------------------

interface CompScopes {
  read: PermissionScope
  manage: PermissionScope
  approve: PermissionScope
}

async function compScopes(scope: TenantScope): Promise<CompScopes> {
  const [read, manage, approve] = await Promise.all(
    ['hr.compensation.read', 'hr.compensation.manage', 'hr.compensation.approve'].map((p) =>
      permissionScope(scope, p)
    )
  )
  return { read, manage, approve }
}

async function employeeFor(scope: TenantScope, s: CompScopes, id: string, lock = false) {
  const e = isUuid(id) ? await findRow(scope, id, lock) : null
  if (!e) throw ApiError.notFound()
  const me = scope.context.membershipId
  const place = placementOf(e)
  const manage = covers(noOwn(s.manage), place, me)
  const approve = covers(noOwn(s.approve), place, me)
  if (!manage && !approve && !covers(s.read, place, me)) throw ApiError.notFound()
  return { e, manage, approve }
}

const PROP_SELECT = `select p.*, p.effective_date::text as eff_text, e.code as employee_code, e.full_name as employee_name,
    e.legal_entity_id, e.branch_id, e.department_id, e.membership_id, u.full_name as decided_by_name,
    cu.full_name as created_by_name
  from compensation_proposals p
  join employees e on e.tenant_id = p.tenant_id and e.id = p.employee_id
  left join tenant_memberships dm on dm.tenant_id = p.tenant_id and dm.id = p.decided_by_membership_id
  left join users u on u.id = dm.user_id
  left join users cu on cu.id = p.created_by`

async function findProposal(scope: TenantScope, id: string, lock = false) {
  if (!isUuid(id)) return null
  const r = await scope.trx.rawQuery(
    `${PROP_SELECT} where p.tenant_id = ? and p.id = ?${lock ? ' for update of p' : ''}`,
    [scope.context.tenantId, id]
  )
  return (r.rows[0] as any) ?? null
}

async function linesOf(scope: TenantScope, proposalId: string) {
  const r = await scope.trx.rawQuery(
    `select l.*, c.code, c.name, c.kind, c.calculation from compensation_proposal_lines l
       join pay_components c on c.tenant_id = l.tenant_id and c.id = l.component_id
      where l.tenant_id = ? and l.proposal_id = ? order by c.kind, c.name`,
    [scope.context.tenantId, proposalId]
  )
  return (r.rows as any[]).map((l) => ({
    componentId: l.component_id as string,
    code: l.code as string,
    name: l.name as string,
    kind: l.kind as string,
    calculation: l.calculation as string,
    action: l.action as 'SET' | 'REMOVE',
    amount: (l.amount as string) ?? null,
    percent: (l.percent as string) ?? null,
  }))
}

function proposalView(p: any, lines: Awaited<ReturnType<typeof linesOf>>) {
  return {
    id: p.id as string,
    version: Number(p.version),
    employee: {
      id: p.employee_id as string,
      code: p.employee_code as string,
      fullName: p.employee_name as string,
    },
    effectiveDate: p.eff_text as string,
    reason: p.reason as string,
    status: p.status as string,
    approvalRequestId: (p.approval_request_id as string) ?? null,
    decidedBy: (p.decided_by_name as string) ?? null,
    decidedAt: p.decided_at ?? null,
    decisionComment: (p.decision_comment as string) ?? null,
    createdBy: (p.created_by_name as string) ?? null,
    createdAt: p.created_at,
    lines,
  }
}

async function componentMap(scope: TenantScope) {
  const r = await scope.trx.rawQuery(
    `select id, calculation, status from pay_components where tenant_id = ?`,
    [scope.context.tenantId]
  )
  return new Map(
    (r.rows as any[]).map((c) => [c.id as string, { calculation: c.calculation, status: c.status }])
  )
}

function proposalInput(input: Record<string, unknown>) {
  const { values: v, issues } = normalizeFields(input, {
    effectiveDate: { kind: 'date', label: 'Data de efeito' },
    reason: { kind: 'longtext', min: 3, max: 2000, label: 'Motivo' },
  })
  for (const k of ['effectiveDate', 'reason'])
    if (!v[k]) issues.push({ path: k, code: 'REQUIRED', message: 'Obrigatório.' })
  return { values: v, issues }
}

async function writeLines(scope: TenantScope, proposalId: string, lines: any[]) {
  await scope.trx.rawQuery(
    `delete from compensation_proposal_lines where tenant_id = ? and proposal_id = ?`,
    [scope.context.tenantId, proposalId]
  )
  for (const l of lines)
    await scope.trx.rawQuery(
      `insert into compensation_proposal_lines (tenant_id, proposal_id, component_id, action, amount, percent,
         created_by, updated_by) values (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        scope.context.tenantId,
        proposalId,
        l.componentId,
        l.action,
        l.action === 'SET' && l.amount !== null && l.amount !== undefined ? String(l.amount) : null,
        l.action === 'SET' && l.percent !== null && l.percent !== undefined
          ? String(l.percent)
          : null,
        scope.context.userId,
        scope.context.userId,
      ] as never[]
    )
}

/**
 * Verificações que dependem do estado actual (ao submeter e de novo ao aplicar): há contrato na data de efeito; cada
 * componente só muda depois do início do período em vigor; só se remove o que existe; o valor bate com o cálculo.
 */
async function stateIssues(scope: TenantScope, employeeId: string, eff: string, lines: any[]) {
  const issues: ErrorDetail[] = []
  const terms = await contractTermsAt(scope, employeeId, eff)
  if (!terms)
    issues.push({
      path: 'effectiveDate',
      code: 'NO_CONTRACT',
      message: 'Não há contrato em vigor nessa data (a remuneração assenta no contrato).',
    })
  const components = await componentMap(scope)
  issues.push(...lineIssues(lines, components))
  for (const [i, l] of lines.entries()) {
    const open = await scope.trx.rawQuery(
      `select valid_from::text as from_text from employee_pay_items where tenant_id = ? and employee_id = ?
         and component_id = ? and valid_to is null`,
      [scope.context.tenantId, employeeId, l.componentId]
    )
    const cur = open.rows[0] as { from_text: string } | undefined
    if (cur && cur.from_text >= eff)
      issues.push({
        path: `lines.${i}.componentId`,
        code: 'NOT_AFTER_CURRENT',
        message: `O valor em vigor começou em ${cur.from_text}: a alteração tem de ser posterior.`,
      })
    if (l.action === 'REMOVE' && !cur)
      issues.push({
        path: `lines.${i}.componentId`,
        code: 'NOTHING_TO_REMOVE',
        message: 'O colaborador não tem este componente.',
      })
  }
  return { issues, terms }
}

/** Aplica a proposta: fecha os períodos em vigor na véspera e abre os novos (histórico nunca reescrito). */
async function applyProposal(scope: TenantScope, p: any) {
  const lines = await linesOf(scope, p.id)
  await findRow(scope, p.employee_id, true)
  const { issues, terms } = await stateIssues(scope, p.employee_id, p.eff_text, lines)
  if (issues.length)
    throw new ApiError(
      409,
      'STALE_PROPOSAL',
      'A proposta já não se aplica ao estado actual; reveja-a.',
      issues
    )
  for (const l of lines) {
    await scope.trx.rawQuery(
      `update employee_pay_items set valid_to = ?, version = version + 1, updated_by = ?, updated_at = now()
        where tenant_id = ? and employee_id = ? and component_id = ? and valid_to is null`,
      [
        previousDay(p.eff_text),
        scope.context.userId,
        scope.context.tenantId,
        p.employee_id,
        l.componentId,
      ]
    )
    if (l.action === 'SET')
      await scope.trx.rawQuery(
        `insert into employee_pay_items (tenant_id, employee_id, component_id, amount, percent, currency, valid_from,
           proposal_id, created_by, updated_by) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          scope.context.tenantId,
          p.employee_id,
          l.componentId,
          l.amount,
          l.percent,
          terms!.currency,
          p.eff_text,
          p.id,
          scope.context.userId,
          scope.context.userId,
        ] as never[]
      )
  }
}

async function setStatus(
  scope: TenantScope,
  p: any,
  status: string,
  extra: Record<string, unknown> = {},
  metadata: Record<string, unknown> | null = null
) {
  const cols = Object.keys(extra)
  await scope.trx.rawQuery(
    `update compensation_proposals set status = ?${cols.map((c) => `, ${c} = ?`).join('')}, version = version + 1,
       updated_by = ?, updated_at = now() where tenant_id = ? and id = ?`,
    [
      status,
      ...cols.map((c) => extra[c]),
      scope.context.userId,
      scope.context.tenantId,
      p.id,
    ] as never[]
  )
  await audit(scope, {
    action: `hr.compensation.${status.toLowerCase()}`,
    entityType: 'compensation_proposal',
    entityId: p.id,
    changes: { status: { from: p.status, to: status } },
    metadata: { employeeId: p.employee_id, effectiveDate: p.eff_text, ...(metadata ?? {}) },
  })
}

async function decideProposal(
  scope: TenantScope,
  p: any,
  outcome: ApprovalOutcome,
  comment: string | null
) {
  if (outcome === 'APPROVED') {
    await applyProposal(scope, p)
    await setStatus(scope, p, 'APPLIED', {
      decided_by_membership_id: scope.context.membershipId,
      decided_at: new Date().toISOString(),
      decision_comment: comment,
    })
  } else
    await setStatus(
      scope,
      p,
      outcome === 'REJECTED' ? 'REJECTED' : 'CANCELLED',
      {
        decided_by_membership_id: scope.context.membershipId,
        decided_at: new Date().toISOString(),
        decision_comment: comment,
      },
      comment ? { comment } : null
    )
}

/** Efeito da conclusão do workflow de uma proposta (registado em `start/module_hooks.ts`). */
export async function onCompensationDecided(
  scope: TenantScope,
  id: string,
  outcome: ApprovalOutcome
) {
  const p = await findProposal(scope, id, true)
  if (!p || p.status !== 'PENDING_APPROVAL') return
  await decideProposal(
    scope,
    p,
    outcome,
    outcome === 'APPROVED'
      ? null
      : outcome === 'REJECTED'
        ? 'Recusada no workflow de aprovação.'
        : 'Pedido de aprovação cancelado.'
  )
}

export class CompensationService {
  /** Remuneração do colaborador: base do contrato, componentes em vigor numa data, histórico e propostas. */
  summary(context: TenantContext, employeeId: string, date: string) {
    return runInTenant(context, async (scope) => {
      const s = await compScopes(scope)
      const { e, manage, approve } = await employeeFor(scope, s, employeeId)
      const history = await scope.trx.rawQuery(
        `select p.*, p.valid_from::text as from_text, p.valid_to::text as to_text, c.code, c.name, c.kind
           from employee_pay_items p join pay_components c on c.tenant_id = p.tenant_id and c.id = p.component_id
          where p.tenant_id = ? and p.employee_id = ? order by c.name, p.valid_from desc`,
        [context.tenantId, e.id]
      )
      const proposals = await scope.trx.rawQuery(
        `${PROP_SELECT} where p.tenant_id = ? and p.employee_id = ? order by p.created_at desc limit 50`,
        [context.tenantId, e.id]
      )
      const props = []
      for (const p of proposals.rows as any[])
        props.push(proposalView(p, await linesOf(scope, p.id)))
      return {
        employee: { id: e.id, code: e.code, fullName: e.full_name },
        at: await compensationAt(scope, e.id, date),
        history: (history.rows as any[]).map((x) => ({
          id: x.id,
          componentId: x.component_id,
          code: x.code,
          name: x.name,
          kind: x.kind,
          amount: x.amount ?? null,
          percent: x.percent ?? null,
          currency: x.currency,
          validFrom: x.from_text,
          validTo: x.to_text ?? null,
          proposalId: x.proposal_id,
        })),
        proposals: props,
        access: { manage, approve },
      }
    })
  }

  list(
    context: TenantContext,
    f: { status?: string; toApprove?: boolean; limit: number; offset: number }
  ) {
    return runInTenant(context, async (scope) => {
      const s = await compScopes(scope)
      const me = context.membershipId
      const parts: string[] = []
      const params: unknown[] = []
      for (const p of [s.read, noOwn(s.manage), noOwn(s.approve)]) {
        const c = scopeClause(p, me)
        if (c) {
          parts.push(c.sql)
          params.push(...c.params)
        }
      }
      if (!parts.length) return { items: [], total: 0 }
      const where = [`p.tenant_id = ?`, `(${parts.join(' or ')})`]
      const all: unknown[] = [context.tenantId, ...params]
      if (f.status) {
        where.push('p.status = ?')
        all.push(f.status)
      }
      if (f.toApprove) {
        const a = scopeClause(noOwn(s.approve), me)
        if (!a) return { items: [], total: 0 }
        where.push(
          `p.status = 'PENDING_APPROVAL'`,
          `p.approval_request_id is null`,
          `p.created_by <> ?`,
          a.sql
        )
        all.push(context.userId, ...a.params)
      }
      const clause = where.join(' and ')
      const rows = await scope.trx.rawQuery(
        `${PROP_SELECT} where ${clause} order by p.created_at desc limit ? offset ?`,
        [...all, f.limit, f.offset] as never[]
      )
      const count = await scope.trx.rawQuery(
        `select count(*)::int as n from compensation_proposals p
           join employees e on e.tenant_id = p.tenant_id and e.id = p.employee_id where ${clause}`,
        all as never[]
      )
      const items = []
      for (const p of rows.rows as any[]) items.push(proposalView(p, await linesOf(scope, p.id)))
      return { items, total: (count.rows[0] as { n: number }).n }
    })
  }

  get(context: TenantContext, id: string) {
    return runInTenant(context, async (scope) => {
      const p = await findProposal(scope, id)
      if (!p) throw ApiError.notFound()
      const s = await compScopes(scope)
      const { manage, approve } = await employeeFor(scope, s, p.employee_id)
      const settings = await hrSettings(scope)
      return {
        ...proposalView(p, await linesOf(scope, id)),
        approvalMode: settings.compensationWorkflowId ? 'WORKFLOW' : 'DIRECT',
        access: {
          manage,
          approve:
            approve &&
            p.status === 'PENDING_APPROVAL' &&
            !p.approval_request_id &&
            p.created_by !== context.userId,
        },
      }
    })
  }

  create(context: TenantContext, employeeId: string, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const s = await compScopes(scope)
      const { e, manage } = await employeeFor(scope, s, employeeId)
      if (!manage)
        throw ApiError.forbidden('OUT_OF_SCOPE', 'Não gere a compensação deste colaborador.')
      if (e.status === 'TERMINATED') wrongState('O colaborador já cessou funções.')
      const { values: v, issues } = proposalInput(input)
      issues.push(...lineIssues(input.lines, await componentMap(scope)))
      fail(issues)
      const r = await scope.trx.rawQuery(
        `insert into compensation_proposals (tenant_id, employee_id, effective_date, reason, created_by, updated_by)
         values (?, ?, ?, ?, ?, ?) returning id`,
        [
          context.tenantId,
          e.id,
          v.effectiveDate,
          v.reason,
          context.userId,
          context.userId,
        ] as never[]
      )
      const id = (r.rows[0] as { id: string }).id
      await writeLines(scope, id, input.lines as any[])
      await audit(scope, {
        action: 'hr.compensation.proposed',
        entityType: 'compensation_proposal',
        entityId: id,
        metadata: {
          employeeId: e.id,
          effectiveDate: v.effectiveDate,
          components: (input.lines as any[]).map((l) => ({
            componentId: l.componentId,
            action: l.action,
            value: RESERVED,
          })),
        },
      })
      return proposalView(await findProposal(scope, id), await linesOf(scope, id))
    })
  }

  update(
    context: TenantContext,
    id: string,
    input: Record<string, unknown>,
    expectedVersion: number
  ) {
    return runInTenant(context, async (scope) => {
      const p = await findProposal(scope, id, true)
      if (!p) throw ApiError.notFound()
      const s = await compScopes(scope)
      const { manage } = await employeeFor(scope, s, p.employee_id)
      if (!manage)
        throw ApiError.forbidden('OUT_OF_SCOPE', 'Não gere a compensação deste colaborador.')
      if (Number(p.version) !== expectedVersion) throw ApiError.versionConflict(Number(p.version))
      if (p.status !== 'DRAFT') wrongState('Só uma proposta em rascunho se altera.')
      const merged = {
        effectiveDate: input.effectiveDate ?? p.eff_text,
        reason: input.reason ?? p.reason,
      }
      const { values: v, issues } = proposalInput(merged)
      if ('lines' in input) issues.push(...lineIssues(input.lines, await componentMap(scope)))
      fail(issues)
      await scope.trx.rawQuery(
        `update compensation_proposals set effective_date = ?, reason = ?, version = version + 1, updated_by = ?,
           updated_at = now() where tenant_id = ? and id = ?`,
        [v.effectiveDate, v.reason, context.userId, context.tenantId, id] as never[]
      )
      if ('lines' in input) await writeLines(scope, id, input.lines as any[])
      await audit(scope, {
        action: 'hr.compensation.updated',
        entityType: 'compensation_proposal',
        entityId: id,
        metadata: { effectiveDate: v.effectiveDate, linesChanged: 'lines' in input },
      })
      return proposalView(await findProposal(scope, id), await linesOf(scope, id))
    })
  }

  submit(context: TenantContext, id: string, expectedVersion: number) {
    return runInTenant(context, async (scope) => {
      const p = await findProposal(scope, id, true)
      if (!p) throw ApiError.notFound()
      const s = await compScopes(scope)
      const { manage } = await employeeFor(scope, s, p.employee_id)
      if (!manage)
        throw ApiError.forbidden('OUT_OF_SCOPE', 'Não gere a compensação deste colaborador.')
      if (Number(p.version) !== expectedVersion) throw ApiError.versionConflict(Number(p.version))
      if (p.status !== 'DRAFT') wrongState('Só uma proposta em rascunho se submete.')
      const lines = await linesOf(scope, id)
      fail((await stateIssues(scope, p.employee_id, p.eff_text, lines)).issues)
      const settings = await hrSettings(scope)
      let requestId: string | null = null
      if (settings.compensationWorkflowId)
        requestId = await submitForSubject(scope, {
          workflowId: settings.compensationWorkflowId,
          subjectType: 'compensation_proposal',
          subjectId: id,
          title: `Compensação: ${p.employee_name} (${p.employee_code})`,
          description: `Efeito ${p.eff_text} · ${lines.length} componente(s)`,
        })
      await setStatus(
        scope,
        p,
        'PENDING_APPROVAL',
        { approval_request_id: requestId },
        requestId ? { approvalRequestId: requestId } : { mode: 'DIRECT' }
      )
      return proposalView(await findProposal(scope, id), lines)
    })
  }

  decide(
    context: TenantContext,
    id: string,
    approve: boolean,
    comment: string | null,
    expectedVersion: number
  ) {
    return runInTenant(context, async (scope) => {
      const p = await findProposal(scope, id, true)
      if (!p) throw ApiError.notFound()
      const s = await compScopes(scope)
      const access = await employeeFor(scope, s, p.employee_id)
      if (!access.approve)
        throw ApiError.forbidden('OUT_OF_SCOPE', 'Não aprova compensação neste âmbito.')
      if (Number(p.version) !== expectedVersion) throw ApiError.versionConflict(Number(p.version))
      if (p.status !== 'PENDING_APPROVAL') wrongState('A proposta não aguarda aprovação.')
      if (p.approval_request_id)
        throw ApiError.conflict(
          'USE_APPROVAL_WORKFLOW',
          'Esta proposta é decidida no workflow de aprovação.'
        )
      if (p.created_by === context.userId)
        throw ApiError.forbidden('SEGREGATION', 'Quem prepara a proposta não a aprova.')
      if (p.membership_id && p.membership_id === context.membershipId)
        throw ApiError.forbidden('SEGREGATION', 'Ninguém aprova a sua própria remuneração.')
      if (!approve && !comment)
        fail([{ path: 'comment', code: 'REQUIRED', message: 'Indique o motivo da recusa.' }])
      await decideProposal(scope, p, approve ? 'APPROVED' : 'REJECTED', comment)
      return proposalView(await findProposal(scope, id), await linesOf(scope, id))
    })
  }

  cancel(context: TenantContext, id: string, expectedVersion: number) {
    return runInTenant(context, async (scope) => {
      const p = await findProposal(scope, id, true)
      if (!p) throw ApiError.notFound()
      const s = await compScopes(scope)
      const { manage } = await employeeFor(scope, s, p.employee_id)
      if (!manage)
        throw ApiError.forbidden('OUT_OF_SCOPE', 'Não gere a compensação deste colaborador.')
      if (Number(p.version) !== expectedVersion) throw ApiError.versionConflict(Number(p.version))
      if (p.status !== 'DRAFT' && !(p.status === 'PENDING_APPROVAL' && !p.approval_request_id))
        wrongState('Esta proposta já não se cancela aqui.')
      await setStatus(scope, p, 'CANCELLED')
      return proposalView(await findProposal(scope, id), await linesOf(scope, id))
    })
  }
}
