import { ApiError } from '#core/http/api_error'
import type { TenantContext, TenantUnitOfWork } from '#core/tenancy/index'
import {
  CALENDAR_VISIBILITIES,
  RESOURCE_TYPES,
  isValidZone,
  validateHolidays,
  validateRange,
  validateWorkingHours,
  workingMinutes,
  type CalendarVisibility,
  type Holiday,
  type ResourceType,
  type WorkingHours,
} from '#modules/calendar/domain/calendar'
import { calendarValidation, failure } from '#modules/calendar/application/errors'
import type {
  BusinessCalendarRecord,
  BusinessCalendarStore,
  CalendarRecord,
  CalendarStore,
  Clock,
  ResourceRecord,
  ResourceStore,
  Viewer,
} from '#modules/calendar/application/ports'

export const viewerOf = (context: TenantContext): Viewer => {
  if (!context.membershipId) throw ApiError.notFound()
  return {
    membershipId: context.membershipId,
    allUnits: context.unitScope.kind === 'ALL',
    unitIds: context.unitScope.kind === 'UNITS' ? context.unitScope.unitIds : [],
  }
}

const unitInScope = (viewer: Viewer, unitId: string | null): boolean =>
  unitId === null || viewer.allUnits || viewer.unitIds.includes(unitId)

/** Um calendário vê-se (e escreve-se, com a permissão) conforme a sua visibilidade. */
export const calendarVisibleTo = (calendar: CalendarRecord, viewer: Viewer): boolean => {
  if (calendar.visibility === 'TENANT') return true
  if (calendar.visibility === 'PRIVATE') return calendar.ownerMembershipId === viewer.membershipId
  return unitInScope(viewer, calendar.unitId)
}

const text = (value: unknown, path: string, max: number, required = true): string | null => {
  if (value === undefined || value === null || value === '') {
    if (required) throw failure(path, 'REQUIRED', 'Campo obrigatório.')
    return null
  }
  if (typeof value !== 'string' || value.trim() === '' || value.trim().length > max)
    throw failure(path, 'INVALID', `Texto inválido (até ${max} caracteres).`)
  return value.trim()
}

const CODE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,49}$/

// --- calendários -------------------------------------------------------------------------------------

export interface CalendarView {
  id: string
  name: string
  ownerMembershipId: string | null
  unitId: string | null
  timezone: string
  visibility: CalendarVisibility
  version: number
  createdAt: string
}

const calendarView = (c: CalendarRecord): CalendarView => ({
  id: c.id,
  name: c.name,
  ownerMembershipId: c.ownerMembershipId,
  unitId: c.unitId,
  timezone: c.timezone,
  visibility: c.visibility,
  version: c.version,
  createdAt: c.createdAt.toISOString(),
})

export class CalendarUseCases {
  constructor(
    private readonly uow: TenantUnitOfWork,
    private readonly calendars: CalendarStore,
    private readonly resources: ResourceStore
  ) {}

  private async body(
    scopeRun: Parameters<Parameters<TenantUnitOfWork['run']>[0]>[0],
    viewer: Viewer,
    input: Record<string, unknown>
  ) {
    const name = text(input['name'], 'name', 160) as string
    const timezone = input['timezone']
    if (!isValidZone(timezone))
      throw failure('timezone', 'INVALID_TIMEZONE', 'Fuso horário IANA inválido.')
    const visibility = input['visibility'] ?? 'PRIVATE'
    if (!(CALENDAR_VISIBILITIES as readonly unknown[]).includes(visibility))
      throw failure('visibility', 'INVALID', 'Visibilidade: PRIVATE, UNIT ou TENANT.')
    let unitId: string | null = null
    if (visibility === 'UNIT') {
      unitId = typeof input['unitId'] === 'string' ? input['unitId'] : null
      if (!unitId) throw failure('unitId', 'REQUIRED', 'Um calendário de unidade indica a unidade.')
      if (!unitInScope(viewer, unitId) || !(await this.resources.unitExists(scopeRun, unitId)))
        throw failure('unitId', 'NOT_FOUND', 'Unidade desconhecida.')
    }
    return { name, timezone, visibility: visibility as CalendarVisibility, unitId }
  }

  async create(context: TenantContext, input: Record<string, unknown>): Promise<CalendarView> {
    const viewer = viewerOf(context)
    return this.uow.run(async (scope) => {
      const body = await this.body(scope, viewer, input)
      return calendarView(
        await this.calendars.insert(scope, { ...body, ownerMembershipId: viewer.membershipId })
      )
    }, context)
  }

  async list(context: TenantContext): Promise<CalendarView[]> {
    const viewer = viewerOf(context)
    return this.uow.run(async (scope) => {
      const all = await this.calendars.list(scope)
      return all.filter((c) => calendarVisibleTo(c, viewer)).map(calendarView)
    }, context)
  }

  /** Para os outros casos de uso: o calendário se a pessoa o vê, senão 404. */
  async visible(
    scope: Parameters<Parameters<TenantUnitOfWork['run']>[0]>[0],
    viewer: Viewer,
    id: string,
    lock = false
  ): Promise<CalendarRecord> {
    const found = lock ? await this.calendars.lock(scope, id) : await this.calendars.find(scope, id)
    if (!found || !calendarVisibleTo(found, viewer)) throw ApiError.notFound()
    return found
  }

  async get(context: TenantContext, id: string): Promise<CalendarView> {
    const viewer = viewerOf(context)
    return this.uow.run(
      async (scope) => calendarView(await this.visible(scope, viewer, id)),
      context
    )
  }

  async update(
    context: TenantContext,
    id: string,
    version: number,
    input: Record<string, unknown>
  ): Promise<CalendarView> {
    const viewer = viewerOf(context)
    return this.uow.run(async (scope) => {
      const current = await this.visible(scope, viewer, id, true)
      if (current.version !== version) throw ApiError.versionConflict(current.version)
      const body = await this.body(scope, viewer, input)
      if (body.visibility === 'PRIVATE' && current.ownerMembershipId !== viewer.membershipId)
        throw failure('visibility', 'NOT_OWNER', 'Só o dono torna um calendário privado.')
      const updated = await this.calendars.update(scope, id, version, body)
      if (!updated) throw ApiError.versionConflict(current.version)
      return calendarView(updated)
    }, context)
  }

  async remove(context: TenantContext, id: string): Promise<void> {
    const viewer = viewerOf(context)
    await this.uow.run(async (scope) => {
      await this.visible(scope, viewer, id, true)
      if (await this.calendars.hasEvents(scope, id))
        throw ApiError.conflict(
          'CALENDAR_NOT_EMPTY',
          'O calendário tem eventos: cancele-os ou mude-os.'
        )
      await this.calendars.remove(scope, id)
    }, context)
  }
}

// --- recursos ----------------------------------------------------------------------------------------

export interface ResourceView {
  id: string
  organizationId: string
  unitId: string | null
  code: string
  name: string
  type: ResourceType
  capacity: number
  active: boolean
  version: number
}

const resourceView = (r: ResourceRecord): ResourceView => ({
  id: r.id,
  organizationId: r.organizationId,
  unitId: r.unitId,
  code: r.code,
  name: r.name,
  type: r.type,
  capacity: r.capacity,
  active: r.active,
  version: r.version,
})

export class ResourceUseCases {
  constructor(
    private readonly uow: TenantUnitOfWork,
    private readonly resources: ResourceStore
  ) {}

  private async body(
    scope: Parameters<Parameters<TenantUnitOfWork['run']>[0]>[0],
    viewer: Viewer,
    input: Record<string, unknown>
  ) {
    const type = input['type']
    if (!(RESOURCE_TYPES as readonly unknown[]).includes(type))
      throw failure('type', 'INVALID', 'Tipo: ROOM, EQUIPMENT, VEHICLE ou OTHER.')
    const capacity = input['capacity'] ?? 1
    if (
      typeof capacity !== 'number' ||
      !Number.isInteger(capacity) ||
      capacity < 1 ||
      capacity > 100000
    )
      throw failure('capacity', 'INVALID', 'A capacidade é um inteiro maior ou igual a 1.')
    let unitId: string | null = null
    if (input['unitId'] !== undefined && input['unitId'] !== null) {
      unitId = typeof input['unitId'] === 'string' ? input['unitId'] : null
      if (
        !unitId ||
        !unitInScope(viewer, unitId) ||
        !(await this.resources.unitExists(scope, unitId))
      )
        throw failure('unitId', 'NOT_FOUND', 'Unidade desconhecida.')
    }
    return {
      name: text(input['name'], 'name', 160) as string,
      type: type as ResourceType,
      capacity,
      unitId,
      active: input['active'] === undefined ? true : input['active'] === true,
    }
  }

  async create(context: TenantContext, input: Record<string, unknown>): Promise<ResourceView> {
    const viewer = viewerOf(context)
    const code = text(input['code'], 'code', 50) as string
    if (!CODE.test(code))
      throw failure('code', 'INVALID', 'Código inválido (letras, números, . _ -).')
    return this.uow.run(async (scope) => {
      const organizationId = input['organizationId']
      if (
        typeof organizationId !== 'string' ||
        !(await this.resources.organizationExists(scope, organizationId))
      )
        throw failure('organizationId', 'NOT_FOUND', 'Organização desconhecida.')
      const body = await this.body(scope, viewer, input)
      const created = await this.resources.insert(scope, { organizationId, code, ...body })
      if (!created)
        throw ApiError.conflict('RESOURCE_CODE_TAKEN', 'Já existe um recurso com este código.')
      return resourceView(created)
    }, context)
  }

  async list(context: TenantContext): Promise<ResourceView[]> {
    const viewer = viewerOf(context)
    return this.uow.run(async (scope) => {
      const all = await this.resources.list(scope)
      return all.filter((r) => unitInScope(viewer, r.unitId)).map(resourceView)
    }, context)
  }

  /** O recurso se a pessoa o vê (pela unidade), senão 404. */
  async visible(
    scope: Parameters<Parameters<TenantUnitOfWork['run']>[0]>[0],
    viewer: Viewer,
    id: string,
    lock = false
  ): Promise<ResourceRecord> {
    const found = lock ? await this.resources.lock(scope, id) : await this.resources.find(scope, id)
    if (!found || !unitInScope(viewer, found.unitId)) throw ApiError.notFound()
    return found
  }

  async get(context: TenantContext, id: string): Promise<ResourceView> {
    const viewer = viewerOf(context)
    return this.uow.run(
      async (scope) => resourceView(await this.visible(scope, viewer, id)),
      context
    )
  }

  async update(
    context: TenantContext,
    id: string,
    version: number,
    input: Record<string, unknown>
  ): Promise<ResourceView> {
    const viewer = viewerOf(context)
    return this.uow.run(async (scope) => {
      const current = await this.visible(scope, viewer, id, true)
      if (current.version !== version) throw ApiError.versionConflict(current.version)
      const body = await this.body(scope, viewer, input)
      const updated = await this.resources.update(scope, id, version, body)
      if (!updated) throw ApiError.versionConflict(current.version)
      return resourceView(updated)
    }, context)
  }

  async remove(context: TenantContext, id: string): Promise<void> {
    const viewer = viewerOf(context)
    try {
      await this.uow.run(async (scope) => {
        await this.visible(scope, viewer, id, true)
        await this.resources.remove(scope, id)
      }, context)
    } catch (error) {
      if ((error as { code?: string } | null)?.code === '23503')
        throw ApiError.conflict(
          'RESOURCE_IN_USE',
          'O recurso tem reservas: desactive-o em vez de o apagar.'
        )
      throw error
    }
  }
}

// --- horário útil ------------------------------------------------------------------------------------

export interface BusinessCalendarView {
  id: string
  organizationId: string
  name: string
  timezone: string
  weeklyWorkingHours: WorkingHours
  holidays: Holiday[]
  version: number
}

const businessView = (b: BusinessCalendarRecord): BusinessCalendarView => ({
  id: b.id,
  organizationId: b.organizationId,
  name: b.name,
  timezone: b.timezone,
  weeklyWorkingHours: b.weeklyWorkingHours,
  holidays: b.holidays,
  version: b.version,
})

export class BusinessCalendarUseCases {
  constructor(
    private readonly uow: TenantUnitOfWork,
    private readonly store: BusinessCalendarStore,
    private readonly clock: Clock
  ) {}

  private body(input: Record<string, unknown>) {
    const name = text(input['name'], 'name', 160) as string
    if (!isValidZone(input['timezone']))
      throw failure('timezone', 'INVALID_TIMEZONE', 'Fuso horário IANA inválido.')
    const hours = validateWorkingHours(input['weeklyWorkingHours'] ?? {})
    if ('issues' in hours) throw calendarValidation(hours.issues)
    const holidays = validateHolidays(input['holidays'] ?? [])
    if ('issues' in holidays) throw calendarValidation(holidays.issues)
    return {
      name,
      timezone: input['timezone'],
      weeklyWorkingHours: hours.value,
      holidays: holidays.value,
    }
  }

  async create(
    context: TenantContext,
    input: Record<string, unknown>
  ): Promise<BusinessCalendarView> {
    viewerOf(context)
    const body = this.body(input)
    return this.uow.run(async (scope) => {
      const organizationId = input['organizationId']
      if (
        typeof organizationId !== 'string' ||
        !(await this.store.organizationExists(scope, organizationId))
      )
        throw failure('organizationId', 'NOT_FOUND', 'Organização desconhecida.')
      const created = await this.store.insert(scope, { organizationId, ...body })
      if (!created)
        throw ApiError.conflict(
          'BUSINESS_CALENDAR_NAME_TAKEN',
          'Já existe um horário com este nome.'
        )
      return businessView(created)
    }, context)
  }

  async list(context: TenantContext): Promise<BusinessCalendarView[]> {
    viewerOf(context)
    return this.uow.run(async (scope) => {
      const all = await this.store.list(scope)
      return all.map(businessView)
    }, context)
  }

  async get(context: TenantContext, id: string): Promise<BusinessCalendarView> {
    viewerOf(context)
    return this.uow.run(async (scope) => {
      const found = await this.store.find(scope, id)
      if (!found) throw ApiError.notFound()
      return businessView(found)
    }, context)
  }

  async update(
    context: TenantContext,
    id: string,
    version: number,
    input: Record<string, unknown>
  ): Promise<BusinessCalendarView> {
    viewerOf(context)
    const body = this.body(input)
    return this.uow.run(async (scope) => {
      const current = await this.store.find(scope, id)
      if (!current) throw ApiError.notFound()
      if (current.version !== version) throw ApiError.versionConflict(current.version)
      const updated = await this.store.update(scope, id, version, body)
      if (!updated) throw ApiError.versionConflict(current.version)
      return businessView(updated)
    }, context)
  }

  async remove(context: TenantContext, id: string): Promise<void> {
    viewerOf(context)
    await this.uow.run(async (scope) => {
      if (!(await this.store.remove(scope, id))) throw ApiError.notFound()
    }, context)
  }

  /** Minutos úteis entre dois instantes (a base de prazos e SLA que respeitam horário e feriados). */
  async workingTime(
    context: TenantContext,
    id: string,
    from: unknown,
    to: unknown
  ): Promise<{ minutes: number; timezone: string; from: string; to: string; asOf: string }> {
    viewerOf(context)
    const range = validateRange(from, to)
    if ('issue' in range) throw calendarValidation([range.issue])
    return this.uow.run(async (scope) => {
      const found = await this.store.find(scope, id)
      if (!found) throw ApiError.notFound()
      return {
        minutes: workingMinutes(
          { timezone: found.timezone, hours: found.weeklyWorkingHours, holidays: found.holidays },
          range.from,
          range.to
        ),
        timezone: found.timezone,
        from: range.from.toISOString(),
        to: range.to.toISOString(),
        asOf: this.clock.now().toISOString(),
      }
    }, context)
  }
}
