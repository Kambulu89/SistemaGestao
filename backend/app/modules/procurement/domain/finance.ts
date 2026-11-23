import type { ErrorDetail } from '#shared/http/api_error'
import {
  divRound,
  isDate,
  parseScaled,
  toFunctional,
} from '#modules/procurement/domain/requisitions'

/*
 * Compras ↔ orçamento, obrigações a pagar e contabilidade (9.10) — regras puras. Valores em cêntimos (bigint),
 * quantidades com 6 casas, câmbios com 10 casas.
 *
 *  Compromisso (por centro de custo e ano, na moeda funcional, líquido de imposto):
 *   - requisição aprovada: Σ líquido × (quantidade − encomendada − fechada) ÷ quantidade, ao câmbio da requisição;
 *   - ordem aprovada e emitida: Σ líquido × (quantidade − cancelada − facturada) ÷ quantidade, ao câmbio da ordem.
 *   A ordem tira à requisição o que encomenda e a factura tira à ordem o que factura: a mesma verba nunca conta duas
 *   vezes. Realizado = facturas validadas − notas de crédito (líquido, ao câmbio da factura).
 *
 *  Contabilidade sem duplicar o Inventário: a recepção de bens armazenáveis já lançou o stock contra a conta de
 *  "recepções por facturar" (regra da empresa para RECEIPT_PURCHASE); a factura **salda essa conta** pelo valor a que
 *  entrou (`goodsReceived`) e só lança a diferença de preço/câmbio (`priceVarianceUp|Down`); serviços e artigos sem
 *  stock vão a `services`. Nunca há débito de stock nas Compras.
 */

export const BUDGET_CONTROLS = ['BLOCK', 'WARN'] as const
export type BudgetControl = (typeof BUDGET_CONTROLS)[number]
export const PAYABLE_STATUSES = ['OPEN', 'PARTIALLY_PAID', 'SETTLED'] as const
export type PayableStatus = (typeof PAYABLE_STATUSES)[number]
export const ACCOUNTING_SOURCE = 'PROCUREMENT'
export const ACCOUNTING_STATUSES = ['PENDING', 'POSTED', 'DRAFTED', 'FAILED'] as const

/** Parte em aberto de um valor de linha: valor × aberto ÷ quantidade (nunca negativo). */
export const openShare = (cents: bigint, quantity: bigint, open: bigint) =>
  quantity <= 0n || open <= 0n
    ? 0n
    : divRound(cents * (open > quantity ? quantity : open), quantity)

export function requisitionCommitment(
  open: boolean,
  rate: bigint,
  lines: { net: bigint; quantity: bigint; ordered: bigint; closed: bigint }[]
) {
  if (!open) return 0n
  const doc = lines.reduce(
    (s, l) => s + openShare(l.net, l.quantity, l.quantity - l.ordered - l.closed),
    0n
  )
  return toFunctional(doc, rate)
}

export function orderCommitment(
  live: boolean,
  rate: bigint,
  lines: { net: bigint; quantity: bigint; cancelled: bigint; invoiced: bigint }[]
) {
  if (!live) return 0n
  const doc = lines.reduce(
    (s, l) => s + openShare(l.net, l.quantity, l.quantity - l.cancelled - l.invoiced),
    0n
  )
  return toFunctional(doc, rate)
}

/** Estado da verba: disponível (pode ser negativo com controlo WARN) e se passou. */
export function budgetState(b: { amount: bigint; committed: bigint; actual: bigint }) {
  const available = b.amount - b.committed - b.actual
  return { available, over: available < 0n }
}

export function normalizeBudget(input: Record<string, unknown>) {
  const issues: ErrorDetail[] = []
  const year = Number(input.fiscalYear)
  if (!Number.isInteger(year) || year < 2000 || year > 2200)
    issues.push({ path: 'fiscalYear', code: 'INVALID', message: 'Ano entre 2000 e 2200.' })
  const amount = parseScaled(input.amount, 2)
  if (amount === null)
    issues.push({ path: 'amount', code: 'INVALID', message: 'Verba ≥ 0, até 2 casas, em texto.' })
  const control = input.control ?? 'BLOCK'
  if (!(BUDGET_CONTROLS as readonly unknown[]).includes(control))
    issues.push({ path: 'control', code: 'INVALID', message: 'Bloquear ou só avisar.' })
  const notes = typeof input.notes === 'string' && input.notes.trim() ? input.notes.trim() : null
  if (notes && notes.length > 500)
    issues.push({ path: 'notes', code: 'LENGTH', message: 'Até 500 caracteres.' })
  return {
    budget: { fiscalYear: year, amount: amount ?? 0n, control: control as BudgetControl, notes },
    issues,
  }
}

/** Estado da obrigação pelo saldo (valor − creditado − pago). */
export function payableStatus(p: {
  amount: bigint
  credited: bigint
  paid: bigint
}): PayableStatus {
  const balance = p.amount - p.credited - p.paid
  if (balance <= 0n) return 'SETTLED'
  return p.paid > 0n ? 'PARTIALLY_PAID' : 'OPEN'
}

export function normalizePayment(input: Record<string, unknown>, today: string) {
  const issues: ErrorDetail[] = []
  const paidOn = input.paidOn === undefined || input.paidOn === '' ? today : input.paidOn
  if (!isDate(paidOn)) issues.push({ path: 'paidOn', code: 'INVALID', message: 'Data AAAA-MM-DD.' })
  else if ((paidOn as string) > today)
    issues.push({
      path: 'paidOn',
      code: 'FUTURE',
      message: 'O pagamento não pode ter data futura.',
    })
  const amount = parseScaled(input.amount, 2)
  if (amount === null || amount <= 0n)
    issues.push({ path: 'amount', code: 'INVALID', message: 'Valor maior que zero, até 2 casas.' })
  const reference = typeof input.reference === 'string' ? input.reference.trim() : ''
  if (!reference || reference.length > 60)
    issues.push({
      path: 'reference',
      code: 'REQUIRED',
      message: 'Referência do pagamento (transferência, cheque), até 60.',
    })
  const notes = typeof input.notes === 'string' && input.notes.trim() ? input.notes.trim() : null
  if (notes && notes.length > 500)
    issues.push({ path: 'notes', code: 'LENGTH', message: 'Até 500 caracteres.' })
  return { payment: { paidOn: paidOn as string, amount: amount ?? 0n, reference, notes }, issues }
}

export interface AccountingLine {
  /** Líquido e imposto do documento (cêntimos, moeda do documento). */
  net: bigint
  tax: bigint
  /** Linha da ordem de um bem que entrou em stock: valor a que entrou (cêntimos, moeda da ordem) para esta quantidade. */
  stockedOrderNet: bigint | null
}

const money = (c: bigint) => {
  const neg = c < 0n
  const a = neg ? -c : c
  return `${neg ? '-' : ''}${a / 100n}.${(a % 100n).toString().padStart(2, '0')}`
}

/**
 * Montantes da factura (ou da nota de crédito, com as mesmas chaves) na moeda funcional: recepções por facturar
 * saldadas ao câmbio da ordem, diferença de preço/câmbio, serviços, imposto e o total a pagar (= soma, para o
 * lançamento ficar equilibrado ao cêntimo).
 */
export function documentAmounts(lines: AccountingLine[], docRate: bigint, orderRate: bigint) {
  let goods = 0n
  let up = 0n
  let down = 0n
  let services = 0n
  let tax = 0n
  for (const l of lines) {
    const net = toFunctional(l.net, docRate)
    tax += toFunctional(l.tax, docRate)
    if (l.stockedOrderNet === null) {
      services += net
      continue
    }
    const received = toFunctional(l.stockedOrderNet, orderRate)
    goods += received
    if (net > received) up += net - received
    else down += received - net
  }
  const payable = goods + up - down + services + tax
  return {
    total: payable,
    amounts: {
      goodsReceived: money(goods),
      priceVarianceUp: money(up),
      priceVarianceDown: money(down),
      services: money(services),
      tax: money(tax),
      payable: money(payable),
    },
  }
}

/** Pagamento: a obrigação sai ao câmbio da factura, o banco ao do pagamento; a diferença é ganho ou perda cambial. */
export function paymentAmounts(amount: bigint, invoiceRate: bigint, paymentRate: bigint) {
  const payable = toFunctional(amount, invoiceRate)
  const bank = toFunctional(amount, paymentRate)
  return {
    total: payable > bank ? payable : bank,
    amounts: {
      payable: money(payable),
      bank: money(bank),
      fxLoss: money(bank > payable ? bank - payable : 0n),
      fxGain: money(payable > bank ? payable - bank : 0n),
    },
  }
}

/** Valor de linha da ordem para uma quantidade (cêntimos, moeda da ordem). */
export const orderValueFor = (orderNet: bigint, orderQuantity: bigint, quantity: bigint) =>
  orderQuantity <= 0n ? 0n : divRound(orderNet * quantity, orderQuantity)
