import type { ErrorDetail } from '#shared/http/api_error'
import { scaled, scaledText } from '#modules/inventory/domain/catalog'

/**
 * Stock (8.3). Cada movimento soma uma quantidade com sinal (unidades base, 6 casas) a um **balde** do saldo:
 *
 *  - físico = livre + bloqueado + quarentena (está no armazém);
 *  - reservado: parte do livre prometida (não sai do físico); disponível = livre − reservado;
 *  - em trânsito: saiu da origem e ainda não entrou no destino (fica no armazém de destino);
 *  - previsto: entradas esperadas (encomendas), sem existência física.
 *
 * Cada tipo de lançamento só pode mexer em certos baldes, com o sinal certo.
 */
export const BUCKETS = [
  'UNRESTRICTED',
  'BLOCKED',
  'QUARANTINE',
  'RESERVED',
  'IN_TRANSIT',
  'EXPECTED',
] as const
export type Bucket = (typeof BUCKETS)[number]
export const PHYSICAL: readonly Bucket[] = ['UNRESTRICTED', 'BLOCKED', 'QUARANTINE']

export const POSTING_TYPES = [
  'RECEIPT',
  'ISSUE',
  'STATUS_CHANGE',
  'RESERVATION',
  'RELEASE',
  'TRANSFER_OUT',
  'TRANSFER_IN',
  'ADJUSTMENT',
  'EXPECTED',
  'REVERSAL',
] as const
export type PostingType = (typeof POSTING_TYPES)[number]

type Sign = '+' | '-' | '±'
/** Baldes e sinais permitidos por tipo (o estorno é construído pelo sistema a partir do original). */
const RULES: Record<Exclude<PostingType, 'REVERSAL'>, Partial<Record<Bucket, Sign>>> = {
  RECEIPT: { UNRESTRICTED: '+', BLOCKED: '+', QUARANTINE: '+', EXPECTED: '-' },
  ISSUE: { UNRESTRICTED: '-', BLOCKED: '-', QUARANTINE: '-', RESERVED: '-' },
  STATUS_CHANGE: { UNRESTRICTED: '±', BLOCKED: '±', QUARANTINE: '±' },
  RESERVATION: { RESERVED: '+' },
  RELEASE: { RESERVED: '-' },
  TRANSFER_OUT: {
    UNRESTRICTED: '-',
    BLOCKED: '-',
    QUARANTINE: '-',
    RESERVED: '-',
    IN_TRANSIT: '+',
  },
  TRANSFER_IN: { UNRESTRICTED: '+', BLOCKED: '+', QUARANTINE: '+', IN_TRANSIT: '-' },
  ADJUSTMENT: { UNRESTRICTED: '±', BLOCKED: '±', QUARANTINE: '±' },
  EXPECTED: { EXPECTED: '±' },
}

export const SCALE = 6

/** Decimal com sinal, até 6 casas → inteiro escalado; `null` se inválido ou zero. */
export function signedQuantity(raw: unknown): bigint | null {
  const v = typeof raw === 'number' ? String(raw) : raw
  if (typeof v !== 'string') return null
  const t = v.trim()
  const neg = t.startsWith('-')
  const q = scaled(neg ? t.slice(1) : t, SCALE)
  if (q === null || q === 0n) return null
  return neg ? -q : q
}

export const quantityText = (v: bigint) => scaledText(v, SCALE)

export interface PostingLine {
  warehouseId: string
  locationId: string | null
  productId: string
  variantId: string | null
  bucket: Bucket
  quantity: bigint
  /** Lote (8.8): só nos baldes físicos e em trânsito. */
  lotId?: string | null
  /** Números de série das unidades movidas (produtos com séries). */
  serials?: string[]
}

/** Chave do saldo: armazém, localização, produto, variante e lote. */
export const keyOf = (
  l: Pick<PostingLine, 'warehouseId' | 'locationId' | 'productId' | 'variantId' | 'lotId'>
) => `${l.warehouseId}|${l.locationId ?? ''}|${l.productId}|${l.variantId ?? ''}|${l.lotId ?? ''}`

/** Coerência das linhas com o tipo de lançamento. */
export function postingIssues(type: PostingType, lines: PostingLine[]): ErrorDetail[] {
  if (type === 'REVERSAL')
    return [{ path: 'type', code: 'INVALID', message: 'Os estornos são criados pelo sistema.' }]
  if (!lines.length)
    return [{ path: 'lines', code: 'REQUIRED', message: 'O lançamento precisa de linhas.' }]
  if (lines.length > 500)
    return [{ path: 'lines', code: 'LENGTH', message: 'No máximo 500 linhas por lançamento.' }]
  const issues: ErrorDetail[] = []
  const rules = RULES[type]
  lines.forEach((l, i) => {
    const sign = rules[l.bucket]
    if (!sign || (sign === '+' && l.quantity < 0n) || (sign === '-' && l.quantity > 0n))
      issues.push({
        path: `lines.${i}.bucket`,
        code: 'BUCKET_NOT_ALLOWED',
        message: `Um lançamento ${type} não pode ${l.quantity > 0n ? 'aumentar' : 'diminuir'} ${l.bucket}.`,
      })
    if (['IN_TRANSIT', 'EXPECTED', 'RESERVED'].includes(l.bucket) && l.locationId)
      issues.push({
        path: `lines.${i}.locationId`,
        code: 'NO_LOCATION',
        message: 'Reservado, em trânsito e previsto contam-se no armazém, sem localização.',
      })
  })
  if (issues.length) return issues
  // Mudança de estado: o físico de cada saldo não muda.
  if (type === 'STATUS_CHANGE') {
    const net = new Map<string, bigint>()
    for (const l of lines) net.set(keyOf(l), (net.get(keyOf(l)) ?? 0n) + l.quantity)
    if ([...net.values()].some((v) => v !== 0n))
      issues.push({
        path: 'lines',
        code: 'NOT_BALANCED',
        message: 'Uma mudança de estado não altera o físico: cada saída de um estado entra noutro.',
      })
  }
  return issues
}

export interface BalanceQuantities {
  unrestricted: bigint
  blocked: bigint
  quarantine: bigint
  reserved: bigint
  inTransit: bigint
  expected: bigint
}

export const physical = (b: BalanceQuantities) => b.unrestricted + b.blocked + b.quarantine
export const available = (b: BalanceQuantities) => b.unrestricted - b.reserved

/** Linhas que anulam as de um lançamento (estorno). */
export const reversalLines = (lines: PostingLine[]) =>
  lines.map((l) => ({ ...l, quantity: -l.quantity }))
