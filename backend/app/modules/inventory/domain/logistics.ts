import { fromDb, parseQty, qtyText } from '#modules/inventory/domain/decimal'
import type { Issue } from '#modules/inventory/domain/stock'

/**
 * Logística de stock (M08). Domínio puro: estados, validação das entradas e aritmética exacta (`bigint` escalado). Os
 * efeitos no stock nunca são campos: são movimentos do livro (M07) com origem única.
 */
export type TransferStatus = 'DRAFT' | 'DISPATCHED' | 'PARTIAL_RECEIVED' | 'RECEIVED' | 'CANCELLED'
export type CountStatus = 'DRAFT' | 'OPEN' | 'REVIEW' | 'POSTED' | 'CANCELLED'
export type ReturnDirection = 'CUSTOMER' | 'SUPPLIER'
export type ReturnStatus = 'DRAFT' | 'APPROVED' | 'POSTED'
export type ReturnCondition = 'SELLABLE' | 'DAMAGED' | 'QUARANTINE'

export const MAX_LINES = 200
export const RETURN_DIRECTIONS: readonly ReturnDirection[] = ['CUSTOMER', 'SUPPLIER']
export const RETURN_CONDITIONS: readonly ReturnCondition[] = ['SELLABLE', 'DAMAGED', 'QUARANTINE']

/** Armazéns técnicos de cada organização (criados à primeira necessidade). */
export const TECHNICAL = {
  transit: {
    warehouse: { code: 'TRANSITO', name: 'Em trânsito' },
    location: { code: 'EM-TRANSITO', name: 'Em trânsito' },
  },
  damaged: {
    warehouse: { code: 'DANIFICADO', name: 'Danificado' },
    location: { code: 'PRINCIPAL', name: 'Principal' },
  },
  quarantine: {
    warehouse: { code: 'QUARENTENA', name: 'Quarentena' },
    location: { code: 'PRINCIPAL', name: 'Principal' },
  },
} as const

const issue = (path: string, code: string, message: string): Issue => ({ path, code, message })

const uuidLike = (value: unknown): value is string => typeof value === 'string' && value.length > 0

export const positiveQty = (value: unknown): bigint | null => {
  const parsed = parseQty(value)
  return parsed !== null && parsed > 0n ? parsed : null
}

export interface TransferLineInput {
  variantId?: unknown
  quantity?: unknown
  lotId?: unknown
  sourceLocationId?: unknown
  destinationLocationId?: unknown
}

export interface TransferLineValues {
  variantId: string
  quantity: string
  lotId: string | null
  sourceLocationId: string | null
  destinationLocationId: string | null
}

export function normalizeTransferLine(
  input: TransferLineInput,
  path: string,
  issues: Issue[]
): TransferLineValues | null {
  const before = issues.length
  if (!uuidLike(input.variantId))
    issues.push(issue(`${path}.variantId`, 'REQUIRED', 'Indique a variante.'))
  const quantity = positiveQty(input.quantity)
  if (quantity === null) {
    issues.push(
      issue(`${path}.quantity`, 'INVALID_QUANTITY', 'Quantidade positiva com até 6 casas.')
    )
  }
  for (const key of ['lotId', 'sourceLocationId', 'destinationLocationId'] as const) {
    const value = input[key]
    if (value !== undefined && value !== null && !uuidLike(value)) {
      issues.push(issue(`${path}.${key}`, 'INVALID_REFERENCE', 'Referência inválida.'))
    }
  }
  if (issues.length > before || quantity === null) return null
  return {
    variantId: input.variantId as string,
    quantity: qtyText(quantity),
    lotId: (input.lotId as string | null | undefined) ?? null,
    sourceLocationId: (input.sourceLocationId as string | null | undefined) ?? null,
    destinationLocationId: (input.destinationLocationId as string | null | undefined) ?? null,
  }
}

/** Quantidade ainda em trânsito de uma linha: expedida menos recebida (nunca negativa). */
export function inTransit(dispatched: string, received: string): string {
  const left = fromDb(dispatched, 6) - fromDb(received, 6)
  return qtyText(left < 0n ? 0n : left)
}

/** Estado da transferência depois de receber: `RECEIVED` só quando nada resta em trânsito em nenhuma linha. */
export function statusAfterReceiving(
  lines: readonly { dispatchedQty: string; receivedQty: string }[]
): 'PARTIAL_RECEIVED' | 'RECEIVED' {
  return lines.every((l) => fromDb(l.receivedQty, 6) >= fromDb(l.dispatchedQty, 6))
    ? 'RECEIVED'
    : 'PARTIAL_RECEIVED'
}

/** Contagem: a variação é `contado − esperado`; sem contagem não há variação. */
export function variance(expected: string, counted: string | null): string | null {
  if (counted === null) return null
  return qtyText(fromDb(counted, 6) - fromDb(expected, 6))
}

export interface ReturnLineInput {
  sourceLineId?: unknown
  quantity?: unknown
  condition?: unknown
  lotId?: unknown
  locationId?: unknown
}

export interface ReturnLineValues {
  sourceLineId: string
  quantity: string
  condition: ReturnCondition
  lotId: string | null
  locationId: string | null
}

export function normalizeReturnLine(
  input: ReturnLineInput,
  path: string,
  issues: Issue[]
): ReturnLineValues | null {
  const before = issues.length
  if (!uuidLike(input.sourceLineId)) {
    issues.push(
      issue(`${path}.sourceLineId`, 'REQUIRED', 'Indique a linha do documento de origem.')
    )
  }
  const quantity = positiveQty(input.quantity)
  if (quantity === null) {
    issues.push(
      issue(`${path}.quantity`, 'INVALID_QUANTITY', 'Quantidade positiva com até 6 casas.')
    )
  }
  const condition = input.condition === undefined ? 'SELLABLE' : input.condition
  if (!RETURN_CONDITIONS.includes(condition as ReturnCondition)) {
    issues.push(
      issue(`${path}.condition`, 'INVALID_CONDITION', 'Estado: SELLABLE, DAMAGED ou QUARANTINE.')
    )
  }
  for (const key of ['lotId', 'locationId'] as const) {
    const value = input[key]
    if (value !== undefined && value !== null && !uuidLike(value)) {
      issues.push(issue(`${path}.${key}`, 'INVALID_REFERENCE', 'Referência inválida.'))
    }
  }
  if (issues.length > before || quantity === null) return null
  return {
    sourceLineId: input.sourceLineId as string,
    quantity: qtyText(quantity),
    condition: condition as ReturnCondition,
    lotId: (input.lotId as string | null | undefined) ?? null,
    locationId: (input.locationId as string | null | undefined) ?? null,
  }
}

/** Quantidade ainda devolvível: o líquido da origem menos o já devolvido (aprovado ou lançado). */
export function returnable(sourceQty: string, returned: string): string {
  const left = fromDb(sourceQty, 6) - fromDb(returned, 6)
  return qtyText(left < 0n ? 0n : left)
}
