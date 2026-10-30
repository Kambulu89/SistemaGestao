import { COST_SCALE, QTY_SCALE, roundDiv } from '#modules/inventory/domain/decimal'

export type MovementKind =
  'RECEIPT' | 'ISSUE' | 'ADJUSTMENT' | 'TRANSFER_IN' | 'TRANSFER_OUT' | 'REVERSAL'

export type ReservationStatus = 'ACTIVE' | 'CONSUMED' | 'RELEASED' | 'EXPIRED'

export interface Issue {
  path: string
  code: string
  message: string
}

const CODE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/
const SOURCE_TYPE = /^[A-Z][A-Z0-9_]{1,39}$/
const DATE = /^\d{4}-\d{2}-\d{2}$/

export const MAX_REASON = 300

export function warehouseIssues(
  input: { code?: unknown; name?: unknown },
  creating: boolean
): Issue[] {
  const issues: Issue[] = []
  if (creating && (typeof input.code !== 'string' || !CODE.test(input.code.trim()))) {
    issues.push({
      path: 'code',
      code: 'INVALID_CODE',
      message: 'Código: letras, números, ponto, hífen ou sublinhado (até 40).',
    })
  }
  if (input.name !== undefined || creating) {
    const name = typeof input.name === 'string' ? input.name.trim() : ''
    if (!name || name.length > 160) {
      issues.push({ path: 'name', code: 'INVALID_NAME', message: 'Indique o nome (até 160).' })
    }
  }
  return issues
}

export function locationIssues(input: { code?: unknown; name?: unknown }): Issue[] {
  return warehouseIssues(input, true)
}

export function lotIssues(input: {
  code?: unknown
  manufacturedOn?: unknown
  expiresOn?: unknown
}): Issue[] {
  const issues: Issue[] = []
  if (typeof input.code !== 'string' || !input.code.trim() || input.code.trim().length > 60) {
    issues.push({
      path: 'code',
      code: 'INVALID_CODE',
      message: 'Indique o código do lote (até 60).',
    })
  }
  for (const key of ['manufacturedOn', 'expiresOn'] as const) {
    const value = input[key]
    if (value !== undefined && value !== null && (typeof value !== 'string' || !DATE.test(value))) {
      issues.push({ path: key, code: 'INVALID_DATE', message: 'A data tem de ser AAAA-MM-DD.' })
    }
  }
  const from = input.manufacturedOn
  const to = input.expiresOn
  if (
    typeof from === 'string' &&
    typeof to === 'string' &&
    DATE.test(from) &&
    DATE.test(to) &&
    to < from
  ) {
    issues.push({
      path: 'expiresOn',
      code: 'EXPIRY_BEFORE_MANUFACTURE',
      message: 'A validade não pode ser anterior ao fabrico.',
    })
  }
  return issues
}

/** Origem de um movimento ou reserva: o documento (e linha) que o originou. Única por tipo/documento/linha/efeito. */
export interface Source {
  type: string
  id: string
  lineId: string | null
  effect: string
}

export function sourceIssues(input: {
  sourceType?: unknown
  sourceId?: unknown
  sourceLineId?: unknown
}): Issue[] {
  const issues: Issue[] = []
  if (typeof input.sourceType !== 'string' || !SOURCE_TYPE.test(input.sourceType)) {
    issues.push({
      path: 'sourceType',
      code: 'INVALID_SOURCE_TYPE',
      message: 'Tipo de origem em maiúsculas (ex.: SALES_ORDER).',
    })
  }
  return issues
}

/**
 * Custo médio móvel por variante e armazém. `quantity`/`avg` são os valores antes do movimento; `delta` o movimento (com
 * sinal) e `unitCost` o custo do movimento. Entradas misturam ao custo do movimento; saídas normais saem ao custo médio
 * (que não muda); a **reversão** de uma entrada tira ao custo original (preserva-se o custo da entrada revertida).
 */
export function nextCost(
  state: { quantity: bigint; avgCost: bigint },
  delta: bigint,
  unitCost: bigint,
  atOriginalCost: boolean
): { quantity: bigint; avgCost: bigint } {
  const quantity = state.quantity + delta
  if (delta > 0n) {
    const base = state.quantity > 0n ? state.quantity : 0n
    const total = base + delta
    // (qtd·custo médio + entrada·custo) / (qtd + entrada); os 6 decimais da quantidade cancelam-se.
    const value = base * state.avgCost + delta * unitCost
    return { quantity, avgCost: roundDiv(value, total) }
  }
  if (!atOriginalCost || quantity <= 0n) return { quantity, avgCost: state.avgCost }
  // Reversão de uma entrada: sai ao custo original e o custo médio recalcula-se sobre o que resta.
  const remaining = state.quantity * state.avgCost - -delta * unitCost
  return { quantity, avgCost: remaining <= 0n ? 0n : roundDiv(remaining, quantity) }
}

export const SCALES = { qty: QTY_SCALE, cost: COST_SCALE }

/** Estado de uma reserva depois de consumir/libertar partes. */
export function reservationStatus(
  quantity: bigint,
  consumed: bigint,
  released: bigint,
  expired: boolean
): ReservationStatus {
  if (consumed + released < quantity) return 'ACTIVE'
  if (consumed > 0n) return 'CONSUMED'
  return expired ? 'EXPIRED' : 'RELEASED'
}
