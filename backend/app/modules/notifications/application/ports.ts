import type { TenantContext, TenantScope } from '#core/tenancy/index'
import type { StoredOutboxEvent } from '#core/outbox/index'
import type {
  Channel,
  Classification,
  DeliveryStatus,
  QuietHours,
  RequestStatus,
} from '#modules/notifications/domain/notifications'

interface Audited {
  id: string
  version: number
  createdAt: Date
}

// --- pedidos e entregas -----------------------------------------------------------------------------

export interface NotificationRequest extends Audited {
  typeCode: string
  templateVersion: string
  classification: Classification
  recipientMembershipId: string | null
  recipientPartyId: string | null
  payload: Record<string, unknown>
  dedupeKey: string
  resourceType: string | null
  resourceId: string | null
  status: RequestStatus
}

export interface NewRequest {
  typeCode: string
  templateVersion: string
  classification: Classification
  recipientMembershipId: string | null
  recipientPartyId: string | null
  payload: Record<string, unknown>
  dedupeKey: string
  resourceType: string | null
  resourceId: string | null
}

/** Visão minimizada de uma entrega para quem administra as falhas: sem payload nem destino. */
export interface Delivery extends Audited {
  requestId: string
  typeCode: string
  channel: Channel
  destinationHint: string | null
  status: DeliveryStatus
  provider: string | null
  providerMessageId: string | null
  attempts: number
  lastErrorCode: string | null
  lastError: string | null
  nextAttemptAt: Date
  sentAt: Date | null
  deliveredAt: Date | null
}

export interface DeliveryFilter {
  status?: DeliveryStatus
  channel?: Channel
  limit: number
  offset: number
}

/** Uma entrega reclamada pelo trabalhador: o destino já decifrado e o texto já renderizado. */
export interface DueDelivery {
  id: string
  requestId: string
  channel: Channel
  destination: string
  typeCode: string
  classification: Classification
  title: string
  body: string
  resourceType: string | null
  resourceId: string | null
  attempts: number
  /** Havia uma tentativa em curso cuja concessão expirou: o resultado dessa tentativa é desconhecido. */
  ambiguous: boolean
}

export interface RequestStore {
  /** Cria o pedido ou devolve o que já existe com a mesma `dedupeKey` (um replay não duplica). */
  insert(
    scope: TenantScope,
    values: NewRequest
  ): Promise<{ request: NotificationRequest; created: boolean }>
  setStatus(scope: TenantScope, id: string, status: RequestStatus): Promise<void>
  /** Estado do pedido derivado das suas entregas. */
  refreshStatus(scope: TenantScope, id: string): Promise<RequestStatus>
}

export interface DeliveryStore {
  insert(
    scope: TenantScope,
    values: {
      requestId: string
      channel: Channel
      destinationEncrypted: string | null
      destinationHint: string | null
      status: DeliveryStatus
      provider: string | null
      nextAttemptAt: Date
    }
  ): Promise<void>
  list(scope: TenantScope, filter: DeliveryFilter): Promise<{ items: Delivery[]; total: number }>
  find(scope: TenantScope, id: string): Promise<Delivery | null>
  /** Reclama as entregas devidas (`FOR UPDATE SKIP LOCKED`), conta a tentativa e concede-as até `leaseUntil`. */
  claimDue(scope: TenantScope, now: Date, limit: number, leaseUntil: Date): Promise<DueDelivery[]>
  recordSent(
    scope: TenantScope,
    id: string,
    result: { provider: string; providerMessageId: string; now: Date }
  ): Promise<void>
  /** Volta à fila (`retryAt`) ou falha de vez (`retryAt` nulo). */
  recordFailure(
    scope: TenantScope,
    id: string,
    failure: { code: string; message: string; retryAt: Date | null }
  ): Promise<void>
  /** `DELIVERED` só depois da confirmação do fornecedor; devolve o id da entrega. */
  confirmDelivered(
    scope: TenantScope,
    provider: string,
    providerMessageId: string,
    now: Date
  ): Promise<string | null>
  /** `FAILED` → `QUEUED` por decisão de quem administra (mantém a chave de dedupe e as tentativas). */
  requeue(scope: TenantScope, id: string, now: Date): Promise<boolean>
  /** Sem destino cifrado de volta: usado só pelo trabalhador na reclamação. */
}

// --- centro e preferências --------------------------------------------------------------------------

export interface Notification extends Audited {
  typeCode: string
  title: string
  body: string
  resourceType: string | null
  resourceId: string | null
  readAt: Date | null
}

export interface CenterStore {
  insert(
    scope: TenantScope,
    values: {
      recipientMembershipId: string
      requestId: string | null
      typeCode: string
      title: string
      body: string
      resourceType: string | null
      resourceId: string | null
    }
  ): Promise<Notification>
  list(
    scope: TenantScope,
    membershipId: string,
    filter: { unread?: boolean; limit: number; offset: number }
  ): Promise<{ items: Notification[]; total: number; unread: number }>
  /** Só encontra uma notificação **do próprio** destinatário. */
  find(scope: TenantScope, membershipId: string, id: string): Promise<Notification | null>
  markRead(scope: TenantScope, membershipId: string, id: string, now: Date): Promise<Notification>
  markAllRead(scope: TenantScope, membershipId: string, now: Date): Promise<number>
}

export interface Preference {
  typeCode: string
  channel: Channel
  enabled: boolean
  quietHours: QuietHours | null
}

export interface PreferenceStore {
  list(scope: TenantScope, membershipId: string): Promise<Preference[]>
  upsert(scope: TenantScope, membershipId: string, values: Preference): Promise<void>
}

// --- fornecedores, cifra e referências --------------------------------------------------------------

export interface OutgoingMessage {
  channel: Channel
  destination: string
  title: string
  body: string
  /** Chave estável da entrega: um fornecedor que a suporta não envia duas vezes a mesma mensagem. */
  dedupeKey: string
}

/** Um erro em que o fornecedor **recusou** a mensagem (nada foi enviado): repetir é seguro. */
export class ProviderError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean
  ) {
    super(message)
    this.name = 'ProviderError'
  }
}

export interface ChannelProvider {
  readonly name: string
  readonly channel: Channel
  /** O fornecedor deduplica pela `dedupeKey`: só assim se repete sem risco uma tentativa de resultado desconhecido. */
  readonly supportsDedupe: boolean
  send(message: OutgoingMessage): Promise<{ providerMessageId: string }>
}

export interface Cipher {
  encrypt(plain: string): string
  decrypt(encoded: string): string
}

export interface References {
  membershipActive(scope: TenantScope, membershipId: string): Promise<boolean>
}

// --- regras de ligação a outros módulos -------------------------------------------------------------

export interface RequestDraft {
  typeCode: string
  recipient: { membershipId?: string; partyId?: string }
  payload: Record<string, unknown>
  /** Distingue vários pedidos do mesmo evento; com o identificador do evento forma a `dedupeKey`. */
  dedupeSuffix: string
  resource?: { type: string; id: string }
  /** Restringe os canais do tipo. */
  channels?: readonly Channel[]
  /** Destinos dos canais externos de quem não é membro (cifrados ao guardar). */
  destinations?: Partial<Record<Channel, string>>
}

export interface NotificationRule {
  code: string
  eventTypes: readonly string[]
  build(context: TenantContext, event: StoredOutboxEvent): Promise<RequestDraft[]>
}

/** Antes de enviar uma mensagem promocional, o módulo dono do destinatário confirma que ainda pode receber. */
export type ConsentGuard = (
  context: TenantContext,
  resourceId: string,
  channel: Channel,
  destination: string
) => Promise<boolean>

export interface ResourceLink {
  /** Permissão actual que o destinatário precisa de ter para abrir o recurso. */
  permission: string
  path: string
  exists(context: TenantContext, id: string): Promise<boolean>
}
