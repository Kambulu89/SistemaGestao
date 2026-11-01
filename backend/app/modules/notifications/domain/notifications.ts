/**
 * Notificações e comunicação (S02). Domínio puro: catálogo de tipos com texto por template declarativo (só substituição
 * de campos, nunca código), classificação (obrigatória, operacional ou promocional), horas de silêncio, repetição com
 * recuo e máscara do destino. Nada aqui conhece a base de dados nem os fornecedores.
 */
export type Channel = 'IN_APP' | 'EMAIL' | 'SMS' | 'WHATSAPP' | 'PUSH'
export type Classification = 'MANDATORY' | 'OPERATIONAL' | 'PROMOTIONAL'
export type RequestStatus = 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED'
export type DeliveryStatus = 'QUEUED' | 'SENT' | 'DELIVERED' | 'FAILED'

export const CHANNELS: readonly Channel[] = ['IN_APP', 'EMAIL', 'SMS', 'WHATSAPP', 'PUSH']
/** Canais com destino externo: o destino guarda-se cifrado e a entrega passa por um fornecedor. */
export const EXTERNAL_CHANNELS: readonly Channel[] = ['EMAIL', 'SMS', 'WHATSAPP', 'PUSH']

export interface Issue {
  path: string
  code: string
  message: string
}

const issue = (path: string, code: string, message: string): Issue => ({ path, code, message })

export interface NotificationType {
  code: string
  templateVersion: string
  classification: Classification
  /** Canais em que o tipo pode ser entregue. */
  channels: readonly Channel[]
  title: string
  body: string
  /** Pode ser pedido por um comando autorizado (`POST /notification-requests`). */
  manual: boolean
  description: string
}

/**
 * Tipos entregues por código. Um módulo pede uma notificação por tipo (template) com um payload mínimo; o texto nunca
 * é escrito por quem pede, excepto nos tipos `manual`, onde o título e o corpo são o próprio payload.
 */
export const NOTIFICATION_TYPES: readonly NotificationType[] = [
  {
    code: 'system.message',
    templateVersion: '1',
    classification: 'OPERATIONAL',
    channels: ['IN_APP'],
    title: '{{title}}',
    body: '{{body}}',
    manual: true,
    description: 'Mensagem operacional enviada por um administrador.',
  },
  {
    code: 'system.mandatory',
    templateVersion: '1',
    classification: 'MANDATORY',
    channels: ['IN_APP'],
    title: '{{title}}',
    body: '{{body}}',
    manual: true,
    description: 'Aviso obrigatório: ignora as preferências de quem o recebe.',
  },
  {
    code: 'system.external_message',
    templateVersion: '1',
    classification: 'OPERATIONAL',
    channels: ['EMAIL', 'SMS', 'WHATSAPP'],
    title: '{{subject}}',
    body: '{{message}}',
    manual: false,
    description:
      'Mensagem operacional a um destinatário externo (por exemplo, a confirmação enviada a um cliente).',
  },
  {
    code: 'crm.lead.converted',
    templateVersion: '1',
    classification: 'OPERATIONAL',
    channels: ['IN_APP'],
    title: 'Lead convertida',
    body: 'Uma lead sua foi convertida em cliente e oportunidade.',
    manual: false,
    description: 'Avisa o responsável de uma lead quando ela é convertida.',
  },
  {
    code: 'calendar.event.cancelled',
    templateVersion: '1',
    classification: 'OPERATIONAL',
    channels: ['IN_APP'],
    title: 'Evento cancelado',
    body: 'O evento «{{title}}» ({{startsAt}}) foi cancelado.',
    manual: false,
    description:
      'Avisa os participantes quando um evento, uma ocorrência ou uma série é cancelada.',
  },
  {
    code: 'calendar.booking.cancelled',
    templateVersion: '1',
    classification: 'OPERATIONAL',
    channels: ['IN_APP'],
    title: 'Reserva cancelada',
    body: 'A reserva de {{resourceName}} para «{{title}}» ({{startsAt}}) foi cancelada; o evento mantém-se.',
    manual: false,
    description:
      'Avisa os participantes quando a reserva de um recurso é cancelada e o evento continua.',
  },
  {
    code: 'crm.campaign.message',
    templateVersion: '1',
    classification: 'PROMOTIONAL',
    channels: ['EMAIL', 'SMS', 'WHATSAPP'],
    title: '{{subject}}',
    body: '{{message}}',
    manual: false,
    description:
      'Mensagem promocional de uma campanha (respeita o consentimento e a lista de exclusão).',
  },
]

export const typeOf = (code: string): NotificationType | undefined =>
  NOTIFICATION_TYPES.find((t) => t.code === code)

export const isChannel = (value: unknown): value is Channel =>
  typeof value === 'string' && (CHANNELS as readonly string[]).includes(value)

const FIELD = /\{\{\s*([a-z][a-zA-Z0-9_]{0,40})\s*\}\}/g
export const MAX_TITLE = 200
export const MAX_BODY = 4000

/** Substitui `{{campo}}` pelo valor de texto do payload (campo em falta vira vazio). Sem expressões nem código. */
export function render(template: string, payload: Readonly<Record<string, unknown>>): string {
  return template.replace(FIELD, (_, key: string) => {
    const value = payload[key]
    return typeof value === 'string' || typeof value === 'number' ? String(value) : ''
  })
}

export function renderType(
  type: NotificationType,
  payload: Readonly<Record<string, unknown>>
): { title: string; body: string } {
  return {
    title: render(type.title, payload).trim().slice(0, MAX_TITLE),
    body: render(type.body, payload).trim().slice(0, MAX_BODY),
  }
}

/** Uma preferência pode desactivar tudo menos o que é obrigatório. */
export const canDisable = (type: NotificationType): boolean => type.classification !== 'MANDATORY'

// --- horas de silêncio ------------------------------------------------------------------------------

export interface QuietHours {
  /** `HH:MM` locais; a janela pode atravessar a meia-noite. */
  start: string
  end: string
  /** Desvio do fuso em minutos em relação ao UTC (Luanda = 60). */
  utcOffsetMinutes: number
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/
const minutesOf = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5))

export function normalizeQuietHours(input: unknown, issues: Issue[]): QuietHours | null {
  if (input === null || input === undefined) return null
  const q = input as Partial<QuietHours>
  if (
    typeof q.start !== 'string' ||
    typeof q.end !== 'string' ||
    !HHMM.test(q.start) ||
    !HHMM.test(q.end)
  ) {
    issues.push(
      issue('quietHours', 'INVALID_QUIET_HOURS', 'Horas de silêncio: início e fim em HH:MM.')
    )
    return null
  }
  if (q.start === q.end) {
    issues.push(issue('quietHours', 'INVALID_QUIET_HOURS', 'O início e o fim não podem coincidir.'))
    return null
  }
  const offset = q.utcOffsetMinutes ?? 0
  if (!Number.isInteger(offset) || offset < -720 || offset > 840) {
    issues.push(issue('quietHours', 'INVALID_QUIET_HOURS', 'Desvio do fuso inválido.'))
    return null
  }
  return { start: q.start, end: q.end, utcOffsetMinutes: offset }
}

/** O instante em que a janela de silêncio termina, se `now` está dentro dela; senão `null`. */
export function quietUntil(quiet: QuietHours | null, now: Date): Date | null {
  if (!quiet) return null
  const start = minutesOf(quiet.start)
  const end = minutesOf(quiet.end)
  const local =
    (((now.getUTCHours() * 60 + now.getUTCMinutes() + quiet.utcOffsetMinutes) % 1440) + 1440) % 1440
  const inside = start < end ? local >= start && local < end : local >= start || local < end
  if (!inside) return null
  const wait = (((end - local) % 1440) + 1440) % 1440
  const until = new Date(now.getTime() + wait * 60_000)
  until.setUTCSeconds(0, 0)
  return until
}

// --- repetição --------------------------------------------------------------------------------------

export const MAX_ATTEMPTS = 5
const BACKOFF_MINUTES = [1, 5, 15, 60, 240]

/** Quando tentar de novo depois de `attempts` tentativas falhadas. */
export const retryAt = (attempts: number, now: Date): Date =>
  new Date(
    now.getTime() +
      (BACKOFF_MINUTES[Math.min(Math.max(attempts, 1), BACKOFF_MINUTES.length) - 1] as number) *
        60_000
  )

// --- destino ----------------------------------------------------------------------------------------

/** Máscara do destino para os administradores: o suficiente para reconhecer, nunca o valor completo. */
export function maskDestination(channel: Channel, destination: string): string {
  if (channel === 'EMAIL') {
    const [local = '', domain = ''] = destination.split('@')
    return `${local.slice(0, 1)}***@${domain}`
  }
  const digits = destination.replace(/\D/g, '')
  return `${destination.startsWith('+') ? '+' : ''}•••${digits.slice(-3)}`
}

/** Erro curto e sem dados pessoais para mostrar a quem administra as falhas. */
export const minimizeError = (message: string): string =>
  message
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]')
    .replace(/\+?\d[\d\s().-]{6,}\d/g, '[número]')
    .slice(0, 300)

// --- pedido manual ----------------------------------------------------------------------------------

export interface ManualRequest {
  typeCode: string
  recipientMembershipIds: string[]
  title: string
  body: string
  dedupeKey: string | null
}

export function normalizeManualRequest(
  input: {
    typeCode?: unknown
    recipientMembershipIds?: unknown
    title?: unknown
    body?: unknown
    dedupeKey?: unknown
  },
  issues: Issue[]
): ManualRequest | null {
  const before = issues.length
  const type = typeof input.typeCode === 'string' ? typeOf(input.typeCode) : undefined
  if (!type || !type.manual) {
    issues.push(
      issue('typeCode', 'INVALID_TYPE', 'Tipo de notificação inválido para pedido manual.')
    )
  }
  const ids = input.recipientMembershipIds
  if (
    !Array.isArray(ids) ||
    ids.length === 0 ||
    ids.length > 200 ||
    ids.some((i) => typeof i !== 'string')
  ) {
    issues.push(issue('recipientMembershipIds', 'INVALID', 'Indique entre 1 e 200 destinatários.'))
  }
  const title = typeof input.title === 'string' ? input.title.trim() : ''
  if (title.length === 0 || title.length > MAX_TITLE) {
    issues.push(issue('title', 'INVALID', `Indique o título (até ${MAX_TITLE} caracteres).`))
  }
  const body = typeof input.body === 'string' ? input.body.trim() : ''
  if (body.length === 0 || body.length > MAX_BODY) {
    issues.push(issue('body', 'INVALID', `Indique o texto (até ${MAX_BODY} caracteres).`))
  }
  const dedupeKey =
    typeof input.dedupeKey === 'string' && input.dedupeKey.trim()
      ? input.dedupeKey.trim().slice(0, 120)
      : null
  if (issues.length > before) return null
  return {
    typeCode: (type as NotificationType).code,
    recipientMembershipIds: [...new Set(ids as string[])],
    title,
    body,
    dedupeKey,
  }
}
