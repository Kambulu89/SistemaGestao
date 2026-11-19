/**
 * Integrações do inventário (8.10): nomes dos eventos enviados ao motor de contabilização e os seus montantes. As
 * contas vêm sempre das regras configuradas pela empresa na contabilidade (origem `INVENTORY` + evento); aqui só se
 * diz **o que aconteceu** e **quanto**, por classe contabilística.
 */
export const ACCOUNTING_SOURCE = 'INVENTORY'
export const NO_CLASS = 'SEM_CLASSE'

export const INTEGRATION_KINDS = [
  'PURCHASE_RECEIPT',
  'SALE_RESERVATION',
  'SALE_RELEASE',
  'SALE_DELIVERY',
  'SALE_RETURN',
] as const
export type IntegrationKind = (typeof INTEGRATION_KINDS)[number]

/** Origem dos lançamentos de stock feitos pelas integrações (aparecem nos movimentos e no livro de custo). */
export const INTEGRATION_SOURCE: Record<IntegrationKind, string> = {
  PURCHASE_RECEIPT: 'PURCHASE_RECEIPT',
  SALE_RESERVATION: 'SALES_ORDER',
  SALE_RELEASE: 'SALES_ORDER',
  SALE_DELIVERY: 'SALES_DELIVERY',
  SALE_RETURN: 'SALES_RETURN',
}

export type Direction = 'IN' | 'OUT'

/**
 * Evento contabilístico de um lançamento de stock, pelo tipo, a origem (e a origem do documento) e o sentido do
 * valor. Movimentos sem efeito no valor (reserva, mudança de estado, transferência dentro da entidade) não chegam aqui.
 */
export function accountingEvent(p: {
  type: string
  sourceType: string
  documentOrigin?: string | null
  direction: Direction
}): string {
  switch (p.type) {
    case 'RECEIPT':
      if (p.sourceType === 'PURCHASE_RECEIPT') return 'RECEIPT_PURCHASE'
      if (p.sourceType === 'SALES_RETURN') return 'RECEIPT_RETURN'
      if (p.sourceType === 'STOCK_DOCUMENT' && p.documentOrigin)
        return `RECEIPT_${p.documentOrigin}`
      return 'RECEIPT_OTHER'
    case 'ISSUE':
      if (p.sourceType === 'SALES_DELIVERY') return 'ISSUE_SALE'
      if (p.sourceType === 'INTERNAL_REQUISITION') return 'ISSUE_CONSUMPTION'
      if (p.sourceType === 'STOCK_DOCUMENT' && p.documentOrigin) return `ISSUE_${p.documentOrigin}`
      return 'ISSUE_OTHER'
    case 'ADJUSTMENT':
      return p.direction === 'IN' ? 'ADJUSTMENT_GAIN' : 'ADJUSTMENT_LOSS'
    case 'TRANSFER_OUT':
    case 'TRANSFER_IN':
      return p.direction === 'IN' ? 'TRANSFER_IN_INTERCOMPANY' : 'TRANSFER_OUT_INTERCOMPANY'
    default:
      return p.direction === 'IN' ? 'STOCK_IN_OTHER' : 'STOCK_OUT_OTHER'
  }
}

/** Evento do estorno: o do original, prefixado (a regra do estorno troca débitos e créditos). */
export const reversalEvent = (original: string) => `REV_${original}`.slice(0, 40)

/** Evento de um ajuste de custo, pelo sinal. */
export const costAdjustmentEvent = (direction: Direction) =>
  direction === 'IN' ? 'COST_ADJUSTMENT_UP' : 'COST_ADJUSTMENT_DOWN'

/** Chave do montante de uma classe no evento (`cls_mercadorias`). */
export const classKey = (cls: string) => `cls_${cls.toLowerCase()}`.slice(0, 40)

/**
 * Montantes do evento: `value` (total) e um por classe contabilística — todas as classes da empresa, a zero quando não
 * se movem, para que uma regra com uma linha por classe funcione sempre (as linhas a zero são omitidas).
 */
export function eventAmounts(byClass: Map<string, bigint>, allClasses: string[]) {
  const amounts: Record<string, string> = {}
  let total = 0n
  for (const v of byClass.values()) total += v
  amounts.value = text(total)
  for (const c of new Set([...allClasses, NO_CLASS, ...byClass.keys()]))
    amounts[classKey(c)] = text(byClass.get(c) ?? 0n)
  return { amounts, total }
}

const text = (cents: bigint) => `${cents / 100n}.${(cents % 100n).toString().padStart(2, '0')}`
