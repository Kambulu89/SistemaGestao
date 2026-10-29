import {
  ProviderError,
  type ChannelProvider,
  type OutgoingMessage,
} from '#modules/notifications/application/ports'
import type { Channel } from '#modules/notifications/domain/notifications'

export interface GatewayOptions {
  channel: Channel
  name: string
  url: string
  token: string | null
  supportsDedupe: boolean
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

/**
 * Conector HTTP genérico para um canal externo. Faz `POST { to, subject, body, dedupeKey }` com o token e a
 * `Idempotency-Key` da entrega. Uma resposta 4xx é uma **recusa** (nada foi enviado; 429 repete-se); qualquer outra
 * falha (tempo esgotado, rede, 5xx) tem resultado desconhecido e só se repete se o fornecedor deduplica.
 */
export class HttpGatewayProvider implements ChannelProvider {
  readonly name: string
  readonly channel: Channel
  readonly supportsDedupe: boolean
  private readonly url: string
  private readonly token: string | null
  private readonly timeoutMs: number
  private readonly fetchImpl: typeof fetch

  constructor(options: GatewayOptions) {
    this.name = options.name
    this.channel = options.channel
    this.supportsDedupe = options.supportsDedupe
    this.url = options.url
    this.token = options.token
    this.timeoutMs = options.timeoutMs ?? 10_000
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  async send(message: OutgoingMessage): Promise<{ providerMessageId: string }> {
    const response = await this.fetchImpl(this.url, {
      method: 'POST',
      signal: AbortSignal.timeout(this.timeoutMs),
      headers: {
        'content-type': 'application/json',
        'idempotency-key': message.dedupeKey,
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      },
      body: JSON.stringify({
        to: message.destination,
        subject: message.title,
        body: message.body,
        dedupeKey: message.dedupeKey,
      }),
    })
    if (response.status >= 400 && response.status < 500) {
      throw new ProviderError(
        `HTTP_${response.status}`,
        `O conector recusou a mensagem (HTTP ${response.status}).`,
        response.status === 429
      )
    }
    if (!response.ok) throw new Error(`O conector respondeu HTTP ${response.status}.`)
    const body = (await response.json().catch(() => null)) as { id?: unknown } | null
    const id =
      body && (typeof body.id === 'string' || typeof body.id === 'number') ? String(body.id) : null
    // Aceite sem identificador: usa-se a chave da entrega, que é estável e única.
    return { providerMessageId: id ?? message.dedupeKey }
  }
}
