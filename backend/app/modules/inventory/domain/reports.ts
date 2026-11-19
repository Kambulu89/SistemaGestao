import { divRound } from '#modules/inventory/domain/valuation'

/*
 * Alertas e relatórios do inventário (8.11) — regras puras, em inteiros (quantidades com 6 casas).
 *
 *  - Reposição: o disponível (livre − reservado) compara-se com o mínimo do produto; o que vem a caminho (em trânsito e
 *    previsto) conta para a sugestão, que repõe até ao máximo (ou ao mínimo, se não houver máximo).
 *  - Rotação: consumo do período ÷ stock médio (abertura + fecho) ÷ 2. Cobertura: disponível ÷ consumo diário.
 *  - Classe do movimento: do tipo de lançamento, da origem e do sentido — o estorno conta na classe do original, com o
 *    sinal contrário, por isso anula-o.
 */

export const REPLENISHMENT_STATUSES = ['STOCKOUT', 'REORDER', 'INCOMING', 'OK'] as const
export type ReplenishmentStatus = (typeof REPLENISHMENT_STATUSES)[number]

export function replenishment(i: {
  available: bigint
  incoming: bigint
  min: bigint | null
  max: bigint | null
}): { status: ReplenishmentStatus; suggested: bigint } {
  const projected = i.available + i.incoming
  const target = i.max ?? i.min
  const short = i.min !== null && i.available <= i.min
  const suggested =
    target !== null && (short || i.available <= 0n) && target > projected ? target - projected : 0n
  if (i.available <= 0n) return { status: 'STOCKOUT', suggested }
  if (!short) return { status: 'OK', suggested: 0n }
  // Abaixo do mínimo: se o que vem a caminho já repõe acima do mínimo, só se acompanha.
  return { status: projected > i.min! ? 'INCOMING' : 'REORDER', suggested }
}

export type ExpiryStatus = 'EXPIRED' | 'EXPIRING'
/** Dias até à validade (negativo = expirado; expira no próprio dia ainda conta como válido, como no FEFO). */
export const expiryStatus = (daysLeft: number): ExpiryStatus =>
  daysLeft < 0 ? 'EXPIRED' : 'EXPIRING'

/** Dias (inclusivos) entre duas datas AAAA-MM-DD. */
export function periodDays(from: string, to: string): number {
  const ms = Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)
  return Math.round(ms / 86_400_000) + 1
}

const ratioText = (hundredths: bigint) => {
  const neg = hundredths < 0n
  const a = neg ? -hundredths : hundredths
  return `${neg ? '-' : ''}${a / 100n}.${(a % 100n).toString().padStart(2, '0')}`
}

export function turnover(i: {
  consumption: bigint
  opening: bigint
  closing: bigint
  available: bigint
  days: number
}) {
  const average = (i.opening + i.closing) / 2n
  const days = BigInt(Math.max(1, i.days))
  return {
    average,
    /** Vezes que o stock médio rodou no período (2 casas); `null` sem stock médio. */
    turnover: average > 0n ? ratioText(divRound(i.consumption * 100n, average)) : null,
    daily: divRound(i.consumption, days),
    /** Dias que o disponível dura ao ritmo do período; `null` sem consumo. */
    coverageDays:
      i.consumption > 0n
        ? Number(divRound((i.available > 0n ? i.available : 0n) * days, i.consumption))
        : null,
  }
}

export const MOVEMENT_CLASSES = [
  'PURCHASE',
  'CUSTOMER_RETURN',
  'PRODUCTION',
  'OPENING',
  'OTHER_RECEIPT',
  'SALE',
  'CONSUMPTION',
  'SAMPLE',
  'SUPPLIER_RETURN',
  'OTHER_ISSUE',
  'LOSS',
  'TRANSFER_LOSS',
  'ADJUSTMENT_LOSS',
  'ADJUSTMENT_GAIN',
  'TRANSFER_IN',
  'TRANSFER_OUT',
  'OTHER',
] as const
export type MovementClass = (typeof MOVEMENT_CLASSES)[number]

/** O que conta como consumo (rotação e cobertura): vendas, consumo interno, amostras e outras saídas. */
export const CONSUMPTION_CLASSES: readonly MovementClass[] = [
  'SALE',
  'CONSUMPTION',
  'SAMPLE',
  'OTHER_ISSUE',
]
/** Perdas: quebras, perdas em trânsito e faltas de contagem (as sobras mostram-se ao lado, para o líquido). */
export const LOSS_CLASSES: readonly MovementClass[] = ['LOSS', 'TRANSFER_LOSS', 'ADJUSTMENT_LOSS']

export function movementClass(m: {
  /** Tipo do lançamento original (o do próprio, se não for estorno). */
  type: string
  sourceType: string | null
  documentOrigin: string | null
  transferLoss: boolean
  /** Sentido no original: `IN` aumenta o stock valorizado do armazém. */
  direction: 'IN' | 'OUT'
}): MovementClass {
  if (m.transferLoss) return 'TRANSFER_LOSS'
  switch (m.type) {
    case 'RECEIPT':
      if (m.sourceType === 'PURCHASE_RECEIPT' || m.documentOrigin === 'PURCHASE') return 'PURCHASE'
      if (m.sourceType === 'SALES_RETURN' || m.documentOrigin === 'RETURN') return 'CUSTOMER_RETURN'
      if (m.documentOrigin === 'PRODUCTION') return 'PRODUCTION'
      if (m.documentOrigin === 'OPENING') return 'OPENING'
      return 'OTHER_RECEIPT'
    case 'ISSUE':
      if (m.sourceType === 'SALES_DELIVERY' || m.documentOrigin === 'SALE') return 'SALE'
      if (m.sourceType === 'INTERNAL_REQUISITION' || m.documentOrigin === 'CONSUMPTION')
        return 'CONSUMPTION'
      if (m.documentOrigin === 'LOSS') return 'LOSS'
      if (m.documentOrigin === 'RETURN') return 'SUPPLIER_RETURN'
      if (m.documentOrigin === 'SAMPLE') return 'SAMPLE'
      return 'OTHER_ISSUE'
    case 'ADJUSTMENT':
      return m.direction === 'IN' ? 'ADJUSTMENT_GAIN' : 'ADJUSTMENT_LOSS'
    case 'TRANSFER_OUT':
    case 'TRANSFER_IN':
      return m.direction === 'IN' ? 'TRANSFER_IN' : 'TRANSFER_OUT'
    default:
      return 'OTHER'
  }
}
