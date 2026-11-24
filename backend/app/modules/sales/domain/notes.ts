import type { ErrorDetail } from '#shared/http/api_error'
import {
  divRound,
  parseScaled,
  PRICE_SCALE,
  QTY_SCALE,
  scaledText,
} from '#modules/sales/domain/pricing'
import type { EngineTax } from '#modules/sales/domain/fiscal'

/*
 * Notas de crédito e débito (10.8) — regras puras.
 *
 *  - A nota referencia sempre a factura original (emitida ou já corrigida) e cada linha uma linha dessa factura.
 *  - Crédito por **quantidade** (devolução, quebra) ou por **valor** (correcção de preço, desconto); débito só por valor.
 *  - Elegível por linha da factura: quantidade ainda não creditada e valor líquido ainda não creditado (contando só as
 *    notas de crédito emitidas). Creditar toda a quantidade que falta credita exactamente o valor que falta.
 *  - Imposto: os mesmos códigos e taxas da linha original (nunca os de hoje), calculados pelo motor fiscal com o nível de
 *    arredondamento da factura; uma retenção só entra se foi aplicada na factura.
 */

export const NOTE_KINDS = ['CREDIT', 'DEBIT'] as const
export type NoteKind = (typeof NOTE_KINDS)[number]
export const NOTE_STATUSES = ['DRAFT', 'ISSUED', 'DISCARDED'] as const
export const NOTE_REASONS: Record<NoteKind, readonly string[]> = {
  CREDIT: ['RETURN', 'PRICE_CORRECTION', 'DISCOUNT', 'DAMAGE', 'CANCELLATION', 'OTHER'],
  DEBIT: ['PRICE_CORRECTION', 'ADDITIONAL_CHARGE', 'INTEREST', 'OTHER'],
}
export const NOTE_MODES = ['QUANTITY', 'VALUE'] as const
export type NoteMode = (typeof NOTE_MODES)[number]

const DATE = /^\d{4}-\d{2}-\d{2}$/
/** Quantidade para mensagens: sem zeros à direita (3.500000 → 3.5). */
export const qtyShort = (v: bigint) => scaledText(v, QTY_SCALE).replace(/\.?0+$/, '') || '0'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface NoteHeader {
  kind: NoteKind
  invoiceId: string
  reasonCode: string
  reason: string
  noteDate: string
  returnId: string | null
}

export function normalizeNoteHeader(input: Record<string, unknown>, creating: boolean) {
  const issues: ErrorDetail[] = []
  const v: Partial<NoteHeader> = {}
  if (creating) {
    if (!(NOTE_KINDS as readonly unknown[]).includes(input.kind))
      issues.push({ path: 'kind', code: 'INVALID', message: 'Crédito ou débito.' })
    else v.kind = input.kind as NoteKind
    if (typeof input.invoiceId !== 'string' || !UUID.test(input.invoiceId))
      issues.push({ path: 'invoiceId', code: 'REQUIRED', message: 'Indique a factura original.' })
    else v.invoiceId = input.invoiceId
  }
  if ('reasonCode' in input || creating) {
    if (typeof input.reasonCode !== 'string' || !input.reasonCode)
      issues.push({ path: 'reasonCode', code: 'REQUIRED', message: 'Escolha o motivo.' })
    else v.reasonCode = input.reasonCode
  }
  if ('reason' in input || creating) {
    const r = typeof input.reason === 'string' ? input.reason.trim() : ''
    if (r.length < 3 || r.length > 500)
      issues.push({ path: 'reason', code: 'REQUIRED', message: 'Descreva o motivo (3 a 500).' })
    else v.reason = r
  }
  if ('noteDate' in input || creating) {
    if (typeof input.noteDate !== 'string' || !DATE.test(input.noteDate))
      issues.push({ path: 'noteDate', code: 'INVALID', message: 'Data obrigatória.' })
    else v.noteDate = input.noteDate
  }
  if ('returnId' in input) {
    const r = input.returnId === '' || input.returnId === undefined ? null : input.returnId
    if (r !== null && (typeof r !== 'string' || !UUID.test(r)))
      issues.push({ path: 'returnId', code: 'INVALID', message: 'Devolução inválida.' })
    else v.returnId = r as string | null
  }
  return { v, issues }
}

/** Valida o código de motivo para o tipo da nota. */
export function reasonIssue(kind: NoteKind, code: string | undefined): ErrorDetail | null {
  if (code === undefined || NOTE_REASONS[kind].includes(code)) return null
  return { path: 'reasonCode', code: 'INVALID', message: 'Motivo inválido para este tipo de nota.' }
}

export interface NoteLineInput {
  invoiceLineId: string
  mode: NoteMode
  quantity: bigint | null
  amount: bigint | null
}

export function normalizeNoteLines(raw: unknown, kind: NoteKind) {
  const issues: ErrorDetail[] = []
  const lines: NoteLineInput[] = []
  if (!Array.isArray(raw) || !raw.length || raw.length > 200) {
    issues.push({ path: 'lines', code: 'REQUIRED', message: 'Indique as linhas a corrigir.' })
    return { lines, issues }
  }
  const seen = new Set<string>()
  raw.forEach((l: any, i: number) => {
    const at = (path: string, code: string, message: string) =>
      issues.push({ path: `lines.${i}.${path}`, code, message })
    if (typeof l?.invoiceLineId !== 'string' || !UUID.test(l.invoiceLineId))
      return at('invoiceLineId', 'REQUIRED', 'Linha da factura.')
    if (seen.has(l.invoiceLineId))
      return at('invoiceLineId', 'DUPLICATE', 'Cada linha da factura uma só vez.')
    seen.add(l.invoiceLineId)
    const mode = l?.mode === 'QUANTITY' ? 'QUANTITY' : l?.mode === 'VALUE' ? 'VALUE' : null
    if (!mode) return at('mode', 'INVALID', 'Por quantidade ou por valor.')
    if (kind === 'DEBIT' && mode === 'QUANTITY')
      return at(
        'mode',
        'INVALID',
        'A nota de débito corrige valores (mais quantidade é outra factura).'
      )
    let quantity: bigint | null = null
    let amount: bigint | null = null
    if (mode === 'QUANTITY') {
      quantity = parseScaled(l?.quantity, QTY_SCALE)
      if (quantity === null || quantity === 0n)
        at('quantity', 'INVALID', 'Quantidade maior que 0, até 6 casas.')
    } else {
      amount = parseScaled(l?.amount, 2)
      if (amount === null || amount === 0n)
        at('amount', 'INVALID', 'Valor líquido maior que 0, 2 casas.')
    }
    lines.push({ invoiceLineId: l.invoiceLineId, mode, quantity, amount })
  })
  return { lines, issues }
}

/** O que resta creditar numa linha da factura. */
export interface LineRoom {
  quantity: bigint // original (6 casas)
  netUnitPrice: string // 4 casas
  netAmount: bigint // original (2 casas)
  creditedQty: bigint
  creditedNet: bigint
}

/**
 * Valor líquido de uma linha da nota (2 casas). Crédito por quantidade: quantidade × preço líquido, nunca acima do que
 * falta; toda a quantidade que falta credita todo o valor que falta. Crédito por valor: nunca acima do valor que falta.
 */
export function noteLineNet(
  kind: NoteKind,
  l: NoteLineInput,
  room: LineRoom
): { net: bigint; issue: { path: string; code: string; message: string } | null } {
  const remainingQty = room.quantity - room.creditedQty
  const remainingNet = room.netAmount - room.creditedNet
  if (kind === 'DEBIT') return { net: l.amount!, issue: null }
  if (l.mode === 'QUANTITY') {
    const q = l.quantity!
    if (q > remainingQty)
      return {
        net: 0n,
        issue: {
          path: 'quantity',
          code: 'OVER_CREDIT',
          message: `Só há ${qtyShort(remainingQty > 0n ? remainingQty : 0n)} por creditar nesta linha.`,
        },
      }
    const price = parseScaled(room.netUnitPrice, PRICE_SCALE)!
    let net =
      q === remainingQty
        ? remainingNet
        : divRound(q * price, 10n ** BigInt(QTY_SCALE + PRICE_SCALE - 2))
    if (net > remainingNet) net = remainingNet
    if (net <= 0n)
      return {
        net: 0n,
        issue: { path: 'quantity', code: 'NOTHING_TO_CREDIT', message: 'Sem valor por creditar.' },
      }
    return { net, issue: null }
  }
  if (l.amount! > remainingNet)
    return {
      net: 0n,
      issue: {
        path: 'amount',
        code: 'OVER_CREDIT',
        message: `Só há ${scaledText(remainingNet > 0n ? remainingNet : 0n, 2)} por creditar nesta linha.`,
      },
    }
  return { net: l.amount!, issue: null }
}

/**
 * Impostos da linha original para o motor fiscal: os mesmos códigos e taxas; uma retenção só se foi aplicada na
 * factura (sem mínimo de base, que já foi decidido na factura).
 */
export function originalTaxes(
  lineTaxes: {
    codeId: string
    code: string
    kind: string
    rate: string
    exemptionCode: string | null
  }[],
  appliedWithholdings: Set<string>
): EngineTax[] {
  return lineTaxes
    .filter((t) => t.kind === 'TAX' || appliedWithholdings.has(t.codeId))
    .map((t) => ({
      codeId: t.codeId,
      code: t.code,
      kind: t.kind as 'TAX' | 'WITHHOLDING',
      rate: t.rate,
      minBase: null,
      exemptionCode: t.exemptionCode,
    }))
}

/** Estado de cobrança de uma factura: em dívida = a pagar + débitos − créditos − pago. */
export function collectionOf(payable: bigint, debited: bigint, credited: bigint, paid: bigint) {
  const open = payable + debited - credited - paid
  if (open <= 0n) return 'PAID'
  return paid > 0n || credited > 0n ? 'PARTIAL' : 'UNPAID'
}
