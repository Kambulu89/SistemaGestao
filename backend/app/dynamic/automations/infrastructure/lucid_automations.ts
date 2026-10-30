import { ApiError } from '#core/http/api_error'
import { LucidTenantScope, type TenantScope } from '#core/tenancy/index'
import {
  GUARD_CODES,
  type ActionDef,
  type AutomationStatus,
  type RunStatus,
} from '#dynamic/automations/domain/automation'
import type {
  Automation,
  AutomationRun,
  AutomationStore,
  AutomationValues,
  NewRun,
  RunStore,
} from '#dynamic/automations/application/ports'

const trxOf = (scope: TenantScope) => (scope as LucidTenantScope).trx
const tenantOf = (scope: TenantScope) => (scope as LucidTenantScope).context.tenantId
const actorOf = (scope: TenantScope) => (scope as LucidTenantScope).context.membershipId as never
const json = (value: unknown) => JSON.stringify(value)

interface AutomationRow {
  id: string
  code: string
  name: string
  description: string | null
  event_type: string | null
  schedule: string | null
  timezone: string
  condition_ast: unknown
  actions: ActionDef[]
  status: AutomationStatus
  max_runs_per_period: number
  run_as_membership_id: string | null
  activated_at: Date | null
  next_run_at: Date | null
  version: number
  created_at: Date
  updated_at: Date
}

const AUTOMATION_COLUMNS = `id, code, name, description, event_type, schedule, timezone, condition_ast, actions, status,
  max_runs_per_period, run_as_membership_id, activated_at, next_run_at, version, created_at, updated_at`

const toAutomation = (r: AutomationRow): Automation => ({
  id: r.id,
  code: r.code,
  name: r.name,
  description: r.description,
  eventType: r.event_type,
  schedule: r.schedule,
  timezone: r.timezone,
  condition: r.condition_ast,
  actions: r.actions,
  status: r.status,
  maxRunsPerPeriod: r.max_runs_per_period,
  runAsMembershipId: r.run_as_membership_id,
  activatedAt: r.activated_at,
  nextRunAt: r.next_run_at,
  version: r.version,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

export class LucidAutomationStore implements AutomationStore {
  async list(scope: TenantScope) {
    const result = await trxOf(scope).rawQuery(
      `select ${AUTOMATION_COLUMNS} from automations where tenant_id = ? order by code`,
      [tenantOf(scope)]
    )
    return (result.rows as AutomationRow[]).map(toAutomation)
  }

  async find(scope: TenantScope, id: string) {
    const result = await trxOf(scope).rawQuery(
      `select ${AUTOMATION_COLUMNS} from automations where tenant_id = ? and id = ?`,
      [tenantOf(scope), id]
    )
    const [row] = result.rows as AutomationRow[]
    return row ? toAutomation(row) : null
  }

  async insert(scope: TenantScope, v: AutomationValues) {
    const result = await trxOf(scope).rawQuery(
      `insert into automations
         (tenant_id, code, name, description, event_type, schedule, timezone, condition_ast, actions,
          max_runs_per_period, created_by_membership_id, updated_by_membership_id)
       values (?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?::jsonb, ?, ?, ?)
       on conflict do nothing
       returning id`,
      [
        tenantOf(scope),
        v.code,
        v.name,
        v.description as never,
        v.eventType as never,
        v.schedule as never,
        v.timezone,
        (v.condition === null ? null : json(v.condition)) as never,
        json(v.actions),
        v.maxRunsPerPeriod,
        actorOf(scope),
        actorOf(scope),
      ]
    )
    const [created] = result.rows as { id: string }[]
    return created ? this.find(scope, created.id) : null
  }

  async update(
    scope: TenantScope,
    id: string,
    expectedVersion: number,
    patch: Partial<Omit<AutomationValues, 'code'>>
  ) {
    const columns: [string, unknown, boolean][] = [
      ['name', patch.name, false],
      ['description', patch.description, false],
      ['event_type', patch.eventType, false],
      ['schedule', patch.schedule, false],
      ['timezone', patch.timezone, false],
      [
        'condition_ast',
        patch.condition === undefined
          ? undefined
          : patch.condition === null
            ? null
            : json(patch.condition),
        true,
      ],
      ['actions', patch.actions === undefined ? undefined : json(patch.actions), true],
      ['max_runs_per_period', patch.maxRunsPerPeriod, false],
    ]
    const entries = columns.filter(([, value]) => value !== undefined)
    const sets = entries
      .map(([column, , asJson]) => `"${column}" = ?${asJson ? '::jsonb' : ''}`)
      .join(', ')
    const result = await trxOf(scope).rawQuery(
      `update automations
          set ${sets}${sets ? ',' : ''} updated_at = now(), updated_by_membership_id = ?, version = version + 1
        where tenant_id = ? and id = ? and version = ? and status <> 'ACTIVE'
        returning id`,
      [...entries.map(([, v]) => v as never), actorOf(scope), tenantOf(scope), id, expectedVersion]
    )
    return this.afterWrite(scope, id, result.rows.length > 0)
  }

  async activate(
    scope: TenantScope,
    id: string,
    expectedVersion: number,
    runAsMembershipId: string,
    nextRunAt: Date | null
  ) {
    const result = await trxOf(scope).rawQuery(
      `update automations
          set status = 'ACTIVE', run_as_membership_id = ?, activated_at = now(), next_run_at = ?,
              updated_at = now(), updated_by_membership_id = ?, version = version + 1
        where tenant_id = ? and id = ? and version = ? and status <> 'ACTIVE'
        returning id`,
      [runAsMembershipId, nextRunAt as never, actorOf(scope), tenantOf(scope), id, expectedVersion]
    )
    return this.afterWrite(scope, id, result.rows.length > 0)
  }

  async pause(scope: TenantScope, id: string, expectedVersion: number) {
    const result = await trxOf(scope).rawQuery(
      `update automations
          set status = 'PAUSED', next_run_at = null, updated_at = now(), updated_by_membership_id = ?,
              version = version + 1
        where tenant_id = ? and id = ? and version = ? and status = 'ACTIVE'
        returning id`,
      [actorOf(scope), tenantOf(scope), id, expectedVersion]
    )
    return this.afterWrite(scope, id, result.rows.length > 0)
  }

  async activeForEvent(scope: TenantScope, eventType: string) {
    const result = await trxOf(scope).rawQuery(
      `select ${AUTOMATION_COLUMNS} from automations
        where tenant_id = ? and status = 'ACTIVE' and event_type = ? order by code`,
      [tenantOf(scope), eventType]
    )
    return (result.rows as AutomationRow[]).map(toAutomation)
  }

  async dueScheduled(scope: TenantScope, now: Date) {
    const result = await trxOf(scope).rawQuery(
      `select ${AUTOMATION_COLUMNS} from automations
        where tenant_id = ? and status = 'ACTIVE' and schedule is not null and next_run_at <= ?
        order by next_run_at for update skip locked`,
      [tenantOf(scope), now as never]
    )
    return (result.rows as AutomationRow[]).map(toAutomation)
  }

  async setNextRun(scope: TenantScope, id: string, nextRunAt: Date | null) {
    // Mudança de calendário interna: não é uma alteração da definição (não incrementa a versão).
    await trxOf(scope).rawQuery(
      `update automations set next_run_at = ?, updated_at = now() where tenant_id = ? and id = ?`,
      [nextRunAt as never, tenantOf(scope), id]
    )
  }

  private async afterWrite(scope: TenantScope, id: string, written: boolean) {
    const row = await this.find(scope, id)
    if (!row) throw ApiError.notFound()
    if (!written) {
      if (row.status === 'ACTIVE') {
        throw ApiError.conflict('AUTOMATION_ACTIVE', 'A automação está activa.')
      }
      throw ApiError.versionConflict(row.version)
    }
    return row
  }
}

interface RunRow {
  id: string
  automation_id: string
  automation_code: string
  automation_version: number
  trigger_event_id: string | null
  scheduled_for: Date | null
  dedupe_key: string
  status: RunStatus
  attempts: number
  next_attempt_at: Date
  causation_id: string | null
  depth: number
  progress: number
  payload: Record<string, unknown>
  error: string | null
  error_code: string | null
  started_at: Date | null
  finished_at: Date | null
  retried_by_membership_id: string | null
  retried_at: Date | null
  created_at: Date
  version: number
}

const RUN_SELECT = `select r.id, r.automation_id, a.code as automation_code, r.automation_version, r.trigger_event_id,
  r.scheduled_for, r.dedupe_key, r.status, r.attempts, r.next_attempt_at, r.causation_id, r.depth, r.progress,
  r.payload, r.error, r.error_code, r.started_at, r.finished_at, r.retried_by_membership_id, r.retried_at,
  r.created_at, r.version
  from automation_runs r
  join automations a on a.tenant_id = r.tenant_id and a.id = r.automation_id`

const toRun = (r: RunRow): AutomationRun => ({
  id: r.id,
  automationId: r.automation_id,
  automationCode: r.automation_code,
  automationVersion: r.automation_version,
  triggerEventId: r.trigger_event_id,
  scheduledFor: r.scheduled_for,
  dedupeKey: r.dedupe_key,
  status: r.status,
  attempts: r.attempts,
  nextAttemptAt: r.next_attempt_at,
  causationId: r.causation_id,
  depth: r.depth,
  progress: r.progress,
  payload: r.payload,
  error: r.error,
  errorCode: r.error_code,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
  retriedByMembershipId: r.retried_by_membership_id,
  retriedAt: r.retried_at,
  createdAt: r.created_at,
  version: r.version,
})

export class LucidRunStore implements RunStore {
  async insertIfAbsent(scope: TenantScope, v: NewRun) {
    const result = await trxOf(scope).rawQuery(
      `insert into automation_runs
         (tenant_id, automation_id, automation_version, trigger_event_id, scheduled_for, dedupe_key, status,
          causation_id, depth, payload, error, error_code, finished_at, created_by_membership_id,
          updated_by_membership_id)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?, ?, ?, ?)
       on conflict (tenant_id, dedupe_key) do nothing
       returning id`,
      [
        tenantOf(scope),
        v.automationId,
        v.automationVersion,
        v.triggerEventId as never,
        v.scheduledFor as never,
        v.dedupeKey,
        v.status,
        v.causationId as never,
        v.depth,
        json(v.payload),
        v.error as never,
        v.errorCode as never,
        (v.status === 'DEAD' ? new Date() : null) as never,
        actorOf(scope),
        actorOf(scope),
      ]
    )
    const [created] = result.rows as { id: string }[]
    return created ? this.find(scope, created.id) : null
  }

  async find(scope: TenantScope, id: string) {
    const result = await trxOf(scope).rawQuery(`${RUN_SELECT} where r.tenant_id = ? and r.id = ?`, [
      tenantOf(scope),
      id,
    ])
    const [row] = result.rows as RunRow[]
    return row ? toRun(row) : null
  }

  async list(scope: TenantScope, filter: { automationId?: string; status?: RunStatus }) {
    const where = ['r.tenant_id = ?']
    const params: unknown[] = [tenantOf(scope)]
    if (filter.automationId) {
      where.push('r.automation_id = ?')
      params.push(filter.automationId)
    }
    if (filter.status) {
      where.push('r.status = ?')
      params.push(filter.status)
    }
    const result = await trxOf(scope).rawQuery(
      `${RUN_SELECT} where ${where.join(' and ')} order by r.created_at desc, r.id limit 200`,
      params as never[]
    )
    return (result.rows as RunRow[]).map(toRun)
  }

  async claimDue(scope: TenantScope, now: Date, limit: number) {
    // Uma execução RUNNING há demasiado tempo (trabalhador que caiu) volta à fila; a tentativa já ficou contada.
    await trxOf(scope).rawQuery(
      `update automation_runs set status = 'PENDING', updated_at = now()
        where tenant_id = ? and status = 'RUNNING' and started_at < ?`,
      [tenantOf(scope), new Date(now.getTime() - 120_000) as never]
    )
    const result = await trxOf(scope).rawQuery(
      `update automation_runs
          set status = 'RUNNING', attempts = attempts + 1, started_at = ?, updated_at = now(),
              version = version + 1
        where tenant_id = ? and id in (
          select id from automation_runs
           where tenant_id = ? and status = 'PENDING' and next_attempt_at <= ?
           order by next_attempt_at, created_at limit ? for update skip locked)
        returning id`,
      [now as never, tenantOf(scope), tenantOf(scope), now as never, limit]
    )
    const runs: AutomationRun[] = []
    for (const { id } of result.rows as { id: string }[]) {
      const run = await this.find(scope, id)
      if (run) runs.push(run)
    }
    return runs
  }

  async setProgress(scope: TenantScope, runId: string, progress: number) {
    await trxOf(scope).rawQuery(
      `update automation_runs set progress = ?, updated_at = now() where tenant_id = ? and id = ?`,
      [progress, tenantOf(scope), runId]
    )
  }

  async succeed(scope: TenantScope, runId: string) {
    await trxOf(scope).rawQuery(
      `update automation_runs
          set status = 'SUCCEEDED', finished_at = now(), error = null, error_code = null, updated_at = now()
        where tenant_id = ? and id = ?`,
      [tenantOf(scope), runId]
    )
  }

  async fail(
    scope: TenantScope,
    runId: string,
    outcome: { status: 'PENDING' | 'DEAD'; nextAttemptAt: Date; error: string; errorCode: string }
  ) {
    await trxOf(scope).rawQuery(
      `update automation_runs
          set status = ?, next_attempt_at = ?, error = ?, error_code = ?, updated_at = now(),
              finished_at = case when ? = 'DEAD' then now() else null end
        where tenant_id = ? and id = ?`,
      [
        outcome.status,
        outcome.nextAttemptAt as never,
        outcome.error,
        outcome.errorCode,
        outcome.status,
        tenantOf(scope),
        runId,
      ]
    )
  }

  async requeue(scope: TenantScope, runId: string, expectedVersion: number) {
    const result = await trxOf(scope).rawQuery(
      `update automation_runs
          set status = 'PENDING', attempts = 0, next_attempt_at = now(), finished_at = null,
              retried_by_membership_id = ?, retried_at = now(), updated_at = now(),
              updated_by_membership_id = ?, version = version + 1
        where tenant_id = ? and id = ? and version = ? and status in ('DEAD', 'FAILED')
        returning id`,
      [actorOf(scope), actorOf(scope), tenantOf(scope), runId, expectedVersion]
    )
    const run = await this.find(scope, runId)
    if (!run) throw ApiError.notFound()
    if (result.rows.length === 0) throw ApiError.versionConflict(run.version)
    return run
  }

  async countSince(scope: TenantScope, automationId: string, since: Date) {
    const result = await trxOf(scope).rawQuery(
      `select count(*)::int as n from automation_runs
        where tenant_id = ? and automation_id = ? and created_at >= ?
          and coalesce(error_code, '') <> all (?::text[])`,
      [tenantOf(scope), automationId, since as never, [...GUARD_CODES, 'CONDITION_ERROR'] as never]
    )
    return (result.rows as { n: number }[])[0]?.n ?? 0
  }

  async automationOf(scope: TenantScope, runId: string) {
    const result = await trxOf(scope).rawQuery(
      `select automation_id from automation_runs where tenant_id = ? and id = ?`,
      [tenantOf(scope), runId]
    )
    return (result.rows as { automation_id: string }[])[0]?.automation_id ?? null
  }
}
