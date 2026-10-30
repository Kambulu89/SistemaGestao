import { randomUUID } from 'node:crypto'
import type { OutboxReader } from '#core/outbox/index'
import {
  serviceTenantContext,
  type TenantContext,
  type TenantUnitOfWork,
} from '#core/tenancy/index'
import { MAX_ATTEMPTS, retryAt } from '#modules/notifications/domain/notifications'
import type { Clock } from '#modules/notifications/application/errors'
import type { RequestService } from '#modules/notifications/application/notification_use_cases'
import {
  ProviderError,
  type DeliveryStore,
  type DueDelivery,
  type RequestStore,
} from '#modules/notifications/application/ports'
import { consentGuardOf, providerOf, rulesFor } from '#modules/notifications/application/registry'

const CONSUMER = 'notifications'
const EVENT_BATCH = 50
const DELIVERY_BATCH = 20
const MAX_BATCHES = 10
/** Concessão de uma entrega reclamada: passado este prazo, a tentativa considera-se de resultado desconhecido. */
const LEASE_MS = 2 * 60_000

export interface TickResult {
  consumed: number
  delivered: number
}

/**
 * Trabalhador das notificações. Por tenant: (1) consome o outbox (cada evento uma só vez, com inbox) e transforma-o em
 * pedidos pelas regras que os módulos registaram; (2) entrega as entregas externas devidas. O fornecedor é chamado **fora**
 * de qualquer transacção, com a chave de dedupe da entrega, e o resultado grava-se depois.
 */
export class NotificationEngine {
  constructor(
    private readonly uow: TenantUnitOfWork,
    private readonly reader: OutboxReader,
    private readonly requestService: RequestService,
    private readonly deliveries: DeliveryStore,
    private readonly requests: RequestStore,
    private readonly clock: Clock,
    private readonly onError: (tenantId: string, error: unknown) => void = () => {}
  ) {}

  async processTenant(tenantId: string): Promise<TickResult> {
    const context = serviceTenantContext(tenantId, `notifications-${randomUUID()}`)
    const consumed = await this.consumeEvents(context)
    const delivered = await this.deliverDue(context)
    return { consumed, delivered }
  }

  // --- outbox → pedidos -----------------------------------------------------------------------

  async consumeEvents(context: TenantContext): Promise<number> {
    let total = 0
    for (let i = 0; i < MAX_BATCHES; i++) {
      const handled = await this.uow.run(async (scope) => {
        const events = await this.reader.undelivered(scope, CONSUMER, EVENT_BATCH)
        for (const event of events) {
          for (const rule of rulesFor(event.eventType)) {
            try {
              const drafts = await rule.build(context, event)
              for (const draft of drafts) {
                await this.requestService.requestIn(
                  scope,
                  draft,
                  `evt:${event.id}:${rule.code}:${draft.dedupeSuffix}`
                )
              }
            } catch (error) {
              // Uma regra com erro não bloqueia o consumo: o evento fica registado como tratado e o erro é reportado.
              this.onError(context.tenantId, error)
            }
          }
          await this.reader.markDelivered(scope, CONSUMER, event.id)
        }
        return events.length
      }, context)
      total += handled
      if (handled < EVENT_BATCH) break
    }
    return total
  }

  // --- entregas externas ----------------------------------------------------------------------

  async deliverDue(context: TenantContext): Promise<number> {
    let total = 0
    for (let i = 0; i < MAX_BATCHES; i++) {
      const now = this.clock.now()
      const claimed = await this.uow.run(
        (scope) =>
          this.deliveries.claimDue(scope, now, DELIVERY_BATCH, new Date(now.getTime() + LEASE_MS)),
        context
      )
      for (const due of claimed) await this.deliverOne(context, due)
      total += claimed.length
      if (claimed.length < DELIVERY_BATCH) break
    }
    return total
  }

  private async fail(
    context: TenantContext,
    due: DueDelivery,
    code: string,
    message: string,
    retry: Date | null
  ) {
    await this.uow.run(async (scope) => {
      await this.deliveries.recordFailure(scope, due.id, { code, message, retryAt: retry })
      await this.requests.refreshStatus(scope, due.requestId)
    }, context)
  }

  private async deliverOne(context: TenantContext, due: DueDelivery): Promise<void> {
    const provider = providerOf(due.channel)
    if (!provider) {
      return this.fail(
        context,
        due,
        'PROVIDER_NOT_CONFIGURED',
        `Não há fornecedor configurado para o canal ${due.channel}.`,
        null
      )
    }
    // Uma tentativa anterior cuja concessão expirou pode ter chegado ao fornecedor: só se repete se ele deduplica.
    if (due.ambiguous && !provider.supportsDedupe) {
      return this.fail(
        context,
        due,
        'AMBIGUOUS_NO_DEDUPE',
        'O resultado da tentativa anterior é desconhecido e o fornecedor não deduplica: repetir pode duplicar a mensagem.',
        null
      )
    }
    if (due.classification === 'PROMOTIONAL') {
      const guard = due.resourceType ? consentGuardOf(due.resourceType) : undefined
      if (!guard || !due.resourceId) {
        return this.fail(
          context,
          due,
          'NO_CONSENT_GUARD',
          'Sem confirmação de consentimento: não se envia.',
          null
        )
      }
      if (!(await guard(context, due.resourceId, due.channel, due.destination))) {
        return this.fail(
          context,
          due,
          'OPTED_OUT',
          'O destinatário recusou comunicações promocionais.',
          null
        )
      }
    }
    try {
      const sent = await provider.send({
        channel: due.channel,
        destination: due.destination,
        title: due.title,
        body: due.body,
        dedupeKey: due.id,
      })
      await this.uow.run(async (scope) => {
        await this.deliveries.recordSent(scope, due.id, {
          provider: provider.name,
          providerMessageId: sent.providerMessageId,
          now: this.clock.now(),
        })
        await this.requests.refreshStatus(scope, due.requestId)
      }, context)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Falha desconhecida do fornecedor.'
      const now = this.clock.now()
      if (error instanceof ProviderError) {
        // O fornecedor recusou: nada foi enviado, repetir é seguro.
        const again = error.retryable && due.attempts < MAX_ATTEMPTS
        return this.fail(
          context,
          due,
          error.code,
          message,
          again ? retryAt(due.attempts, now) : null
        )
      }
      // Erro sem resposta clara (tempo esgotado): pode ter sido aceite. Só se repete com dedupe.
      if (provider.supportsDedupe && due.attempts < MAX_ATTEMPTS) {
        return this.fail(context, due, 'PROVIDER_UNKNOWN', message, retryAt(due.attempts, now))
      }
      return this.fail(context, due, 'AMBIGUOUS_NO_DEDUPE', message, null)
    }
  }
}

/** Percorre os tenants operacionais; um erro num tenant não pára os outros. */
export class NotificationWorker {
  constructor(
    private readonly engine: NotificationEngine,
    private readonly tenants: () => Promise<string[]>,
    private readonly onError: (tenantId: string, error: unknown) => void = () => {}
  ) {}

  async tick(): Promise<TickResult> {
    const total: TickResult = { consumed: 0, delivered: 0 }
    for (const tenantId of await this.tenants()) {
      try {
        const result = await this.engine.processTenant(tenantId)
        total.consumed += result.consumed
        total.delivered += result.delivered
      } catch (error) {
        this.onError(tenantId, error)
      }
    }
    return total
  }
}
