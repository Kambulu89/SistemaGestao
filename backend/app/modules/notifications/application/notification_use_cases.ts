import { randomUUID } from 'node:crypto'
import { ApiError } from '#core/http/api_error'
import type { TenantContext, TenantScope, TenantUnitOfWork } from '#core/tenancy/index'
import {
  CHANNELS,
  EXTERNAL_CHANNELS,
  NOTIFICATION_TYPES,
  canDisable,
  isChannel,
  maskDestination,
  normalizeManualRequest,
  normalizeQuietHours,
  quietUntil,
  renderType,
  typeOf,
  type Channel,
  type Issue,
  type NotificationType,
  type QuietHours,
} from '#modules/notifications/domain/notifications'
import {
  failure,
  MAX_PAGE,
  notificationValidation,
  type Clock,
} from '#modules/notifications/application/errors'
import type {
  CenterStore,
  Cipher,
  Delivery,
  DeliveryStore,
  Notification,
  NotificationRequest,
  Preference,
  PreferenceStore,
  References,
  RequestDraft,
  RequestStore,
} from '#modules/notifications/application/ports'
import { resourceLinkOf } from '#modules/notifications/application/registry'

const page = (filter: { limit?: number; offset?: number }) => ({
  limit: Math.min(filter.limit ?? 50, MAX_PAGE),
  offset: filter.offset ?? 0,
})

const membershipOf = (context: TenantContext): string => {
  if (!context.membershipId) throw ApiError.notFound()
  return context.membershipId
}

// --- pedidos ----------------------------------------------------------------------------------------

/**
 * Cria pedidos de notificação e as suas entregas. O pedido é único por `dedupeKey`: repetir (um replay do outbox, um
 * retry do cliente) devolve o mesmo pedido e não cria mais nada. O canal interno entrega logo no centro; os canais
 * externos ficam na fila para o trabalhador. As preferências contam, excepto nos avisos obrigatórios.
 */
export class RequestService {
  constructor(
    private readonly uow: TenantUnitOfWork,
    private readonly requests: RequestStore,
    private readonly deliveries: DeliveryStore,
    private readonly center: CenterStore,
    private readonly preferences: PreferenceStore,
    private readonly references: References,
    private readonly cipher: Cipher,
    private readonly clock: Clock
  ) {}

  request(
    context: TenantContext,
    draft: RequestDraft,
    dedupeKey: string
  ): Promise<{ request: NotificationRequest; created: boolean }> {
    return this.uow.run((scope) => this.requestIn(scope, draft, dedupeKey), context)
  }

  /** Dentro de uma transacção já aberta (o consumo do outbox e o pedido manual). */
  async requestIn(scope: TenantScope, draft: RequestDraft, dedupeKey: string) {
    const type = typeOf(draft.typeCode)
    if (!type) throw failure('typeCode', 'INVALID_TYPE', 'Tipo de notificação desconhecido.')
    const { membershipId, partyId } = draft.recipient
    if (membershipId && !(await this.references.membershipActive(scope, membershipId))) {
      throw failure('recipient', 'UNKNOWN_RECIPIENT', 'O destinatário não é um membro activo.')
    }
    const { request, created } = await this.requests.insert(scope, {
      typeCode: type.code,
      templateVersion: type.templateVersion,
      classification: type.classification,
      recipientMembershipId: membershipId ?? null,
      recipientPartyId: partyId ?? null,
      payload: draft.payload,
      dedupeKey,
      resourceType: draft.resource?.type ?? null,
      resourceId: draft.resource?.id ?? null,
    })
    if (!created) return { request, created }
    const prefs = membershipId ? await this.preferences.list(scope, membershipId) : []
    const now = this.clock.now()
    const wanted = (draft.channels ?? type.channels).filter((c) => type.channels.includes(c))
    for (const channel of wanted) {
      const pref = prefs.find((p) => p.typeCode === type.code && p.channel === channel)
      if (pref && !pref.enabled && canDisable(type)) continue
      if (channel === 'IN_APP') {
        if (!membershipId) continue
        const text = renderType(type, draft.payload)
        await this.center.insert(scope, {
          recipientMembershipId: membershipId,
          requestId: request.id,
          typeCode: type.code,
          title: text.title,
          body: text.body,
          resourceType: draft.resource?.type ?? null,
          resourceId: draft.resource?.id ?? null,
        })
        await this.deliveries.insert(scope, {
          requestId: request.id,
          channel,
          destinationEncrypted: null,
          destinationHint: null,
          status: 'DELIVERED',
          provider: 'in_app',
          nextAttemptAt: now,
        })
        continue
      }
      const destination = draft.destinations?.[channel]
      if (!destination) continue
      // Um mandatório ignora as horas de silêncio; o resto espera que a janela termine.
      const quiet = canDisable(type) ? (pref?.quietHours ?? null) : null
      await this.deliveries.insert(scope, {
        requestId: request.id,
        channel,
        destinationEncrypted: this.cipher.encrypt(destination),
        destinationHint: maskDestination(channel, destination),
        status: 'QUEUED',
        provider: null,
        nextAttemptAt: quietUntil(quiet, now) ?? now,
      })
    }
    await this.requests.refreshStatus(scope, request.id)
    return { request, created }
  }

  /** Pedido manual de um administrador (`communication.manage`): uma notificação por destinatário. */
  async sendManual(
    context: TenantContext,
    input: Parameters<typeof normalizeManualRequest>[0]
  ): Promise<{ requested: number; duplicates: number }> {
    const issues: Issue[] = []
    const manual = normalizeManualRequest(input, issues)
    if (!manual) throw notificationValidation(issues)
    const batch = manual.dedupeKey ?? `manual:${randomUUID()}`
    return this.uow.run(async (scope) => {
      let requested = 0
      let duplicates = 0
      for (const membershipId of manual.recipientMembershipIds) {
        const result = await this.requestIn(
          scope,
          {
            typeCode: manual.typeCode,
            recipient: { membershipId },
            payload: { title: manual.title, body: manual.body },
            dedupeSuffix: membershipId,
          },
          `${batch}:${membershipId}`
        )
        if (result.created) requested++
        else duplicates++
      }
      return { requested, duplicates }
    }, context)
  }
}

// --- centro -----------------------------------------------------------------------------------------

/** O centro de notificações de cada pessoa: só vê e só altera as suas. */
export class CenterUseCases {
  constructor(
    private readonly uow: TenantUnitOfWork,
    private readonly center: CenterStore,
    private readonly clock: Clock
  ) {}

  list(context: TenantContext, filter: { unread?: boolean; limit?: number; offset?: number }) {
    const membershipId = membershipOf(context)
    return this.uow.run(
      (scope) => this.center.list(scope, membershipId, { ...filter, ...page(filter) }),
      context
    )
  }

  /** Marca como lida. Repetir não faz nada; uma notificação de outra pessoa não existe para quem pede (404). */
  markRead(context: TenantContext, id: string): Promise<Notification> {
    const membershipId = membershipOf(context)
    return this.uow.run(async (scope) => {
      if (!(await this.center.find(scope, membershipId, id))) throw ApiError.notFound()
      return this.center.markRead(scope, membershipId, id, this.clock.now())
    }, context)
  }

  markAllRead(context: TenantContext): Promise<{ marked: number }> {
    const membershipId = membershipOf(context)
    return this.uow.run(
      async (scope) => ({
        marked: await this.center.markAllRead(scope, membershipId, this.clock.now()),
      }),
      context
    )
  }

  /**
   * Abre o recurso a que a notificação se refere. O acesso revalida-se **agora**: a notificação pode ter sido criada
   * quando a pessoa tinha acesso e perdê-lo depois (permissão retirada, recurso apagado). Sem acesso não se devolve nada.
   */
  open(
    context: TenantContext,
    id: string,
    allowed: (permission: string) => Promise<boolean>
  ): Promise<{ resourceType: string; resourceId: string; path: string }> {
    const membershipId = membershipOf(context)
    return this.uow.run(async (scope) => {
      const found = await this.center.find(scope, membershipId, id)
      if (!found) throw ApiError.notFound()
      if (!found.resourceType || !found.resourceId) {
        throw ApiError.conflict('NO_RESOURCE', 'Esta notificação não tem um recurso associado.')
      }
      const link = resourceLinkOf(found.resourceType)
      if (!link)
        throw ApiError.conflict('NO_RESOURCE', 'O recurso desta notificação já não se abre aqui.')
      if (!(await allowed(link.permission)) || !(await link.exists(context, found.resourceId))) {
        throw new ApiError(
          403,
          'RESOURCE_ACCESS_REVOKED',
          'Já não tem acesso ao recurso desta notificação.'
        )
      }
      await this.center.markRead(scope, membershipId, id, this.clock.now())
      return { resourceType: found.resourceType, resourceId: found.resourceId, path: link.path }
    }, context)
  }
}

// --- preferências -----------------------------------------------------------------------------------

export interface PreferenceView {
  typeCode: string
  description: string
  classification: NotificationType['classification']
  channel: Channel
  enabled: boolean
  /** O aviso obrigatório não se desactiva. */
  locked: boolean
  quietHours: QuietHours | null
}

/** Preferências por tipo e canal (as próprias de cada pessoa). Por omissão tudo está activo. */
export class PreferenceUseCases {
  constructor(
    private readonly uow: TenantUnitOfWork,
    private readonly preferences: PreferenceStore
  ) {}

  list(context: TenantContext): Promise<PreferenceView[]> {
    const membershipId = membershipOf(context)
    return this.uow.run(async (scope) => {
      const stored = await this.preferences.list(scope, membershipId)
      return NOTIFICATION_TYPES.flatMap((type) =>
        type.channels.map<PreferenceView>((channel) => {
          const pref = stored.find((p) => p.typeCode === type.code && p.channel === channel)
          return {
            typeCode: type.code,
            description: type.description,
            classification: type.classification,
            channel,
            enabled: pref ? pref.enabled || !canDisable(type) : true,
            locked: !canDisable(type),
            quietHours: pref?.quietHours ?? null,
          }
        })
      )
    }, context)
  }

  async update(
    context: TenantContext,
    input: {
      typeCode?: unknown
      channel?: unknown
      enabled?: unknown
      quietHours?: unknown
    }[]
  ): Promise<PreferenceView[]> {
    const membershipId = membershipOf(context)
    const issues: Issue[] = []
    const values: Preference[] = []
    input.forEach((item, i) => {
      const type = typeof item.typeCode === 'string' ? typeOf(item.typeCode) : undefined
      const path = `preferences.${i}`
      if (!type) {
        issues.push({
          path: `${path}.typeCode`,
          code: 'INVALID_TYPE',
          message: 'Tipo desconhecido.',
        })
        return
      }
      if (!isChannel(item.channel) || !type.channels.includes(item.channel)) {
        issues.push({
          path: `${path}.channel`,
          code: 'INVALID_CHANNEL',
          message: 'Canal inválido para este tipo.',
        })
        return
      }
      if (typeof item.enabled !== 'boolean') {
        issues.push({
          path: `${path}.enabled`,
          code: 'INVALID',
          message: 'Indique se está activo.',
        })
        return
      }
      if (!item.enabled && !canDisable(type)) {
        issues.push({
          path: `${path}.enabled`,
          code: 'MANDATORY_NOTIFICATION',
          message: 'Um aviso obrigatório não se desactiva.',
        })
        return
      }
      const quietHours = normalizeQuietHours(item.quietHours, issues)
      values.push({ typeCode: type.code, channel: item.channel, enabled: item.enabled, quietHours })
    })
    if (issues.length > 0) throw notificationValidation(issues)
    await this.uow.run(async (scope) => {
      for (const v of values) await this.preferences.upsert(scope, membershipId, v)
    }, context)
    return this.list(context)
  }
}

// --- administração das entregas ---------------------------------------------------------------------

/** Quem administra a comunicação vê as falhas **minimizadas** (sem texto, sem payload, destino mascarado). */
export class DeliveryAdminUseCases {
  constructor(
    private readonly uow: TenantUnitOfWork,
    private readonly deliveries: DeliveryStore,
    private readonly requests: RequestStore,
    private readonly clock: Clock
  ) {}

  list(
    context: TenantContext,
    filter: { status?: Delivery['status']; channel?: Channel; limit?: number; offset?: number }
  ) {
    return this.uow.run(
      (scope) => this.deliveries.list(scope, { ...filter, ...page(filter) }),
      context
    )
  }

  /** Volta a pôr na fila uma entrega falhada (mantém a chave de dedupe: um fornecedor que a suporta não duplica). */
  retry(context: TenantContext, id: string): Promise<Delivery> {
    return this.uow.run(async (scope) => {
      const found = await this.deliveries.find(scope, id)
      if (!found) throw ApiError.notFound()
      if (found.status !== 'FAILED') {
        throw ApiError.conflict('DELIVERY_NOT_FAILED', 'Só se repete uma entrega falhada.')
      }
      await this.deliveries.requeue(scope, id, this.clock.now())
      await this.requests.refreshStatus(scope, found.requestId)
      return (await this.deliveries.find(scope, id)) as Delivery
    }, context)
  }

  /**
   * Confirmação do fornecedor: só ela faz uma entrega `DELIVERED` (`SENT` é só «aceite»). Chamada pelo adaptador do
   * fornecedor quando recebe o aviso; repetir não faz nada.
   */
  confirmDelivered(
    context: TenantContext,
    provider: string,
    providerMessageId: string
  ): Promise<boolean> {
    return this.uow.run(async (scope) => {
      const id = await this.deliveries.confirmDelivered(
        scope,
        provider,
        providerMessageId,
        this.clock.now()
      )
      if (!id) return false
      const found = await this.deliveries.find(scope, id)
      if (found) await this.requests.refreshStatus(scope, found.requestId)
      return true
    }, context)
  }
}

export { CHANNELS, EXTERNAL_CHANNELS }
