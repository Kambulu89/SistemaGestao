import { ApiError, type ErrorDetail } from '#shared/http/api_error'
import { runInTenant, type TenantContext, type TenantScope } from '#modules/tenancy/index'
import { audit } from '#modules/audit/index'
import { employeeAccess } from '#modules/hr/application/employee_service'
import { insertOnboardingTask } from '#modules/hr/application/recruitment_service'
import {
  ONBOARDING_FIELDS,
  ONBOARDING_STATUSES,
  normalizeFields,
} from '#modules/hr/domain/recruitment'

/**
 * Checklist de onboarding do colaborador (7.2): documentos, conta, acessos e equipamentos. Ver segue `hr.read` no
 * âmbito do colaborador; gerir segue `hr.manage`; o responsável de uma tarefa pode concluí-la.
 */

const SELECT = `select t.*, t.due_date::text as due_date_text, u.full_name as assignee_name
  from onboarding_tasks t
  left join tenant_memberships m on m.tenant_id = t.tenant_id and m.id = t.assignee_membership_id
  left join users u on u.id = m.user_id`

function view(t: any) {
  return {
    id: t.id as string,
    version: Number(t.version),
    employeeId: t.employee_id as string,
    category: t.category as string,
    title: t.title as string,
    dueDate: (t.due_date_text as string) ?? null,
    assignee: t.assignee_membership_id
      ? { membershipId: t.assignee_membership_id as string, name: t.assignee_name as string }
      : null,
    status: t.status as string,
    notes: (t.notes as string) ?? null,
    completedAt: t.completed_at ?? null,
  }
}

async function readTask(scope: TenantScope, id: string, lock = false) {
  const r = await scope.trx.rawQuery(
    `${SELECT} where t.tenant_id = ? and t.id = ?${lock ? ' for update of t' : ''}`,
    [scope.context.tenantId, id]
  )
  return (r.rows[0] as any) ?? null
}

export class OnboardingService {
  list(context: TenantContext, employeeId: string) {
    return runInTenant(context, async (scope) => {
      const access = await employeeAccess(scope, employeeId, 'general')
      if (!access) throw ApiError.notFound()
      const r = await scope.trx.rawQuery(
        `${SELECT} where t.tenant_id = ? and t.employee_id = ?
          order by case t.category when 'DOCUMENTS' then 1 when 'ACCOUNT' then 2 when 'ACCESS' then 3
            when 'EQUIPMENT' then 4 else 5 end, t.created_at`,
        [context.tenantId, employeeId]
      )
      const items = (r.rows as any[]).map(view)
      return {
        items,
        done: items.filter((t) => t.status !== 'PENDING').length,
        total: items.length,
        canManage: access.write,
      }
    })
  }

  create(context: TenantContext, employeeId: string, input: Record<string, unknown>) {
    return runInTenant(context, async (scope) => {
      const access = await employeeAccess(scope, employeeId, 'general')
      if (!access) throw ApiError.notFound()
      if (!access.write)
        throw ApiError.forbidden('OUT_OF_SCOPE', 'Não gere o onboarding deste colaborador.')
      const id = await insertOnboardingTask(scope, employeeId, input)
      return view(await readTask(scope, id))
    })
  }

  update(
    context: TenantContext,
    id: string,
    input: Record<string, unknown>,
    expectedVersion: number
  ) {
    return runInTenant(context, async (scope) => {
      const t = await readTask(scope, id, true)
      if (!t) throw ApiError.notFound()
      const access = await employeeAccess(scope, t.employee_id, 'general')
      const assignee = t.assignee_membership_id === context.membershipId
      if (!access && !assignee) throw ApiError.notFound()
      const statusOnly = Object.keys(input).every((k) => k === 'status' || k === 'notes')
      if (!access?.write && !(assignee && statusOnly))
        throw ApiError.forbidden('OUT_OF_SCOPE', 'Não pode alterar esta tarefa.')
      if (Number(t.version) !== expectedVersion) throw ApiError.versionConflict(Number(t.version))
      const { values: v, issues } = normalizeFields(input, ONBOARDING_FIELDS)
      if ('title' in v && !v.title)
        issues.push({ path: 'title', code: 'REQUIRED', message: 'Obrigatório.' })
      if ('status' in input && !ONBOARDING_STATUSES.includes(input.status as never))
        issues.push({
          path: 'status',
          code: 'INVALID',
          message: 'Pendente, feita ou não aplicável.',
        })
      if (issues.length) throw ApiError.validation(issues as ErrorDetail[])
      const columns: Record<string, string> = {
        title: 'title',
        dueDate: 'due_date',
        assigneeMembershipId: 'assignee_membership_id',
        notes: 'notes',
      }
      const sets = Object.keys(v).map((k) => `${columns[k]} = ?`)
      const params: unknown[] = Object.keys(v).map((k) => v[k])
      if ('status' in input && input.status !== t.status) {
        sets.push('status = ?', 'completed_at = ?', 'completed_by = ?')
        const done = input.status !== 'PENDING'
        params.push(
          input.status,
          done ? new Date().toISOString() : null,
          done ? context.userId : null
        )
      }
      if (sets.length) {
        await scope.trx.rawQuery(
          `update onboarding_tasks set ${sets.join(', ')}, version = version + 1, updated_by = ?, updated_at = now()
            where tenant_id = ? and id = ?`,
          [...params, context.userId, context.tenantId, id] as never[]
        )
        await audit(scope, {
          action: 'hr.onboarding.task_updated',
          entityType: 'onboarding_task',
          entityId: id,
          changes:
            'status' in input && input.status !== t.status
              ? { status: { from: t.status, to: input.status } }
              : null,
          metadata: { employeeId: t.employee_id, fields: Object.keys(input) },
        })
      }
      return view(await readTask(scope, id))
    })
  }
}
