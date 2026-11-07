import type { ErrorDetail } from '#shared/http/api_error'
import { isUuid } from '#shared/db/sql'

/**
 * Assuntos que podem ser aprovados: `manual` (pedido avulso, sem registo associado) e os registos de módulos que
 * submetem aprovações (`bank_account`: alteração de dados bancários institucionais). Cada módulo regista o efeito
 * da conclusão no próprio módulo (`registerSubjectHandler`).
 */
export const SUBJECT_TYPES = ['manual', 'bank_account'] as const
export type SubjectType = (typeof SUBJECT_TYPES)[number]

export type WorkflowStatus = 'DRAFT' | 'ACTIVE' | 'RETIRED'
export type RequestStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED'
export type ApproverType = 'ROLE' | 'MEMBER'
export type Decision = 'APPROVE' | 'REJECT'

export interface StepValues {
  sequence: number
  name: string
  approverType: ApproverType
  approverRoleId: string | null
  approverMembershipId: string | null
  requiredApprovals: number
}

export interface WorkflowValues {
  code: string
  name: string
  description: string | null
  subjectType: SubjectType
  steps: StepValues[]
}

export const MAX_STEPS = 10
/** Duração máxima de uma delegação. */
export const MAX_DELEGATION_DAYS = 366

const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '')

/** Valida e normaliza a definição (campos, etapas numeradas 1..n pela ordem recebida). */
export function normalizeWorkflow(
  input: Record<string, unknown>,
  current: WorkflowValues | null
): { values: WorkflowValues | null; issues: ErrorDetail[] } {
  const issues: ErrorDetail[] = []
  const pick = <K extends keyof WorkflowValues>(key: K) =>
    input[key] !== undefined ? input[key] : current?.[key]

  const code = text(pick('code')).toUpperCase()
  if (current && input.code !== undefined && code !== current.code)
    issues.push({ path: 'code', code: 'IMMUTABLE', message: 'O código não se altera.' })
  else if (!/^[A-Z][A-Z0-9_]{1,39}$/.test(code))
    issues.push({ path: 'code', code: 'INVALID', message: 'Código: 2–40 letras, dígitos ou _.' })

  const name = text(pick('name'))
  if (name.length < 3 || name.length > 160)
    issues.push({ path: 'name', code: 'LENGTH', message: 'Nome com 3 a 160 caracteres.' })

  const rawDescription = pick('description')
  const description = rawDescription === null ? null : text(rawDescription) || null
  if (description && description.length > 2000)
    issues.push({ path: 'description', code: 'LENGTH', message: 'Até 2000 caracteres.' })

  const subjectType = text(pick('subjectType')) as SubjectType
  if (!SUBJECT_TYPES.includes(subjectType))
    issues.push({
      path: 'subjectType',
      code: 'INVALID',
      message: `Tipo de assunto: ${SUBJECT_TYPES.join(', ')}.`,
    })

  const rawSteps = input.steps !== undefined ? input.steps : current?.steps
  const steps: StepValues[] = []
  if (!Array.isArray(rawSteps)) {
    issues.push({ path: 'steps', code: 'REQUIRED', message: 'Indique as etapas.' })
  } else if (rawSteps.length > MAX_STEPS) {
    issues.push({ path: 'steps', code: 'TOO_MANY', message: `No máximo ${MAX_STEPS} etapas.` })
  } else {
    rawSteps.forEach((raw: any, i) => {
      const path = `steps.${i}`
      const stepName = text(raw?.name)
      if (stepName.length < 2 || stepName.length > 120)
        issues.push({
          path: `${path}.name`,
          code: 'LENGTH',
          message: 'Nome com 2 a 120 caracteres.',
        })
      const approverType = raw?.approverType as ApproverType
      const roleId = raw?.approverRoleId ?? null
      const membershipId = raw?.approverMembershipId ?? null
      const required = raw?.requiredApprovals ?? 1
      if (approverType === 'ROLE') {
        if (!isUuid(roleId))
          issues.push({
            path: `${path}.approverRoleId`,
            code: 'REQUIRED',
            message: 'Indique o perfil.',
          })
        if (membershipId !== null)
          issues.push({
            path: `${path}.approverMembershipId`,
            code: 'NOT_ALLOWED',
            message: 'Só com aprovador MEMBER.',
          })
      } else if (approverType === 'MEMBER') {
        if (!isUuid(membershipId))
          issues.push({
            path: `${path}.approverMembershipId`,
            code: 'REQUIRED',
            message: 'Indique o membro.',
          })
        if (roleId !== null)
          issues.push({
            path: `${path}.approverRoleId`,
            code: 'NOT_ALLOWED',
            message: 'Só com aprovador ROLE.',
          })
        if (required !== 1)
          issues.push({
            path: `${path}.requiredApprovals`,
            code: 'INVALID',
            message: 'Um membro aprova uma vez.',
          })
      } else {
        issues.push({ path: `${path}.approverType`, code: 'INVALID', message: 'ROLE ou MEMBER.' })
      }
      if (!Number.isInteger(required) || required < 1 || required > 20)
        issues.push({ path: `${path}.requiredApprovals`, code: 'RANGE', message: 'Entre 1 e 20.' })
      steps.push({
        sequence: i + 1,
        name: stepName,
        approverType,
        approverRoleId: approverType === 'ROLE' ? roleId : null,
        approverMembershipId: approverType === 'MEMBER' ? membershipId : null,
        requiredApprovals: required,
      })
    })
  }
  if (issues.length > 0) return { values: null, issues }
  return { values: { code, name, description, subjectType, steps }, issues }
}

/** Valida o pedido de aprovação (manual: título obrigatório, sem registo associado). */
export function normalizeRequest(input: Record<string, unknown>) {
  const issues: ErrorDetail[] = []
  const title = text(input.title)
  if (title.length < 3 || title.length > 200)
    issues.push({ path: 'title', code: 'LENGTH', message: 'Título com 3 a 200 caracteres.' })
  const description = text(input.description) || null
  if (description && description.length > 5000)
    issues.push({ path: 'description', code: 'LENGTH', message: 'Até 5000 caracteres.' })
  if (!isUuid(input.workflowId))
    issues.push({ path: 'workflowId', code: 'REQUIRED', message: 'Indique o workflow.' })
  return { values: { title, description, workflowId: input.workflowId as string }, issues }
}
