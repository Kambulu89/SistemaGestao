/**
 * Contagens físicas e ajustes (8.7). Plano (rascunho) → início com snapshot do stock físico de cada saldo no âmbito
 * (número da série) → contagem (cega: quem só conta não vê o sistema) → revisão (diferenças, justificação, recontagem
 * de linhas) → aprovação, que lança o ajuste. O ajuste de cada linha é `contado − snapshot`: o que entrou ou saiu
 * depois do snapshot já está no saldo e não é anulado. Uma recontagem renova o snapshot dessa linha.
 */
export const COUNT_STATUSES = ['DRAFT', 'COUNTING', 'REVIEW', 'APPROVED', 'CANCELLED'] as const
export type CountStatus = (typeof COUNT_STATUSES)[number]

export const COUNT_SERIES_TYPE = 'STOCK_COUNT'

export const COUNT_CAN: Record<
  'edit' | 'start' | 'count' | 'addLine' | 'submit' | 'justify' | 'recount' | 'approve' | 'cancel',
  readonly CountStatus[]
> = {
  edit: ['DRAFT'],
  start: ['DRAFT'],
  count: ['COUNTING'],
  addLine: ['COUNTING'],
  submit: ['COUNTING'],
  justify: ['REVIEW'],
  recount: ['REVIEW'],
  approve: ['REVIEW'],
  cancel: ['DRAFT', 'COUNTING', 'REVIEW'],
}

/** Motivos de diferença (a justificação escrita acompanha sempre o motivo). */
export const COUNT_REASONS = [
  'COUNT_ERROR',
  'UNRECORDED_RECEIPT',
  'UNRECORDED_ISSUE',
  'DAMAGE',
  'EXPIRY',
  'THEFT_LOSS',
  'LOCATION_MIX',
  'OTHER',
] as const
export type CountReason = (typeof COUNT_REASONS)[number]

/** Limite de linhas por contagem (o plano deve ser restringido por zona ou categoria). */
export const MAX_COUNT_LINES = 2000

export interface PhysicalQuantities {
  unrestricted: bigint
  blocked: bigint
  quarantine: bigint
}

/** Diferença de uma linha contada (`null` enquanto não contada). */
export const countDifference = (l: { snapshot: bigint; counted: bigint | null }) =>
  l.counted === null ? null : l.counted - l.snapshot

/**
 * Reparte o ajuste de um saldo pelos baldes físicos: sobras entram no livre; faltas saem do livre, depois da
 * quarentena e do bloqueado. Devolve as parcelas (com sinal) e o que não foi possível cobrir.
 */
export function splitAdjustment(
  delta: bigint,
  current: PhysicalQuantities
): {
  parts: { bucket: 'UNRESTRICTED' | 'QUARANTINE' | 'BLOCKED'; quantity: bigint }[]
  shortfall: bigint
} {
  if (delta === 0n) return { parts: [], shortfall: 0n }
  if (delta > 0n) return { parts: [{ bucket: 'UNRESTRICTED', quantity: delta }], shortfall: 0n }
  let left = -delta
  const parts: { bucket: 'UNRESTRICTED' | 'QUARANTINE' | 'BLOCKED'; quantity: bigint }[] = []
  for (const [bucket, have] of [
    ['UNRESTRICTED', current.unrestricted],
    ['QUARANTINE', current.quarantine],
    ['BLOCKED', current.blocked],
  ] as const) {
    if (left === 0n) break
    const take = have < left ? have : left
    if (take > 0n) {
      parts.push({ bucket, quantity: -take })
      left -= take
    }
  }
  return { parts, shortfall: left }
}

/** Linhas que impedem a aprovação: por contar ou com diferença sem motivo e justificação. */
export function approvalIssues(
  lines: {
    lineNo: number
    snapshot: bigint
    counted: bigint | null
    reasonCode: string | null
    justification: string | null
  }[]
): { lineNo: number; code: 'NOT_COUNTED' | 'NOT_JUSTIFIED' }[] {
  const out: { lineNo: number; code: 'NOT_COUNTED' | 'NOT_JUSTIFIED' }[] = []
  for (const l of lines) {
    const d = countDifference(l)
    if (d === null) out.push({ lineNo: l.lineNo, code: 'NOT_COUNTED' })
    else if (d !== 0n && (!l.reasonCode || !l.justification))
      out.push({ lineNo: l.lineNo, code: 'NOT_JUSTIFIED' })
  }
  return out
}

/**
 * O que cada um vê. A quantidade do sistema (snapshot, diferença, movimentos desde o snapshot) numa contagem cega só
 * é mostrada a quem aprova, até à aprovação; numa contagem aberta, a todos os que a podem consultar.
 */
export const seesBook = (c: { blind: boolean; status: CountStatus }, approver: boolean) =>
  !c.blind || approver || c.status === 'APPROVED'
