import type { ErrorDetail } from '#shared/http/api_error'
import {
  formatDecimal,
  multiply,
  parseDecimal,
  type Rounding,
} from '#modules/accounting/domain/decimal'

/** Regras puras da contabilidade (sem base de dados): contas, exercícios, partidas dobradas. */

export const NATURES = [
  'ASSET',
  'LIABILITY',
  'EQUITY',
  'REVENUE',
  'EXPENSE',
  'OFF_BALANCE',
] as const
export const LEVELS = ['CLASS', 'ACCOUNT', 'SUBACCOUNT'] as const
export const JOURNAL_TYPES = [
  'GENERAL',
  'SALES',
  'PURCHASES',
  'CASH',
  'BANK',
  'PAYROLL',
  'INVENTORY',
  'OPENING',
  'ADJUSTMENT',
] as const
export const RATE_SCALE = 10
/** Casas decimais guardadas nas linhas (`numeric(24,6)`); o arredondamento usa a precisão da empresa. */
export const STORAGE_SCALE = 6

/** Saldo normal sugerido pela natureza (pode ser alterado, p. ex. contas de amortização acumulada). */
export const defaultNormalBalance = (nature: string) =>
  nature === 'ASSET' || nature === 'EXPENSE' ? 'DEBIT' : 'CREDIT'

/** Hierarquia: classe na raiz; conta e subconta sob um pai; código do filho começa pelo código do pai. */
export function checkAccountPlacement(
  account: { code: string; level: string },
  parent: { code: string; level: string; postable: boolean } | null
): ErrorDetail[] {
  const issues: ErrorDetail[] = []
  if (account.level === 'CLASS' && parent)
    issues.push({ path: 'parentId', code: 'CLASS_IS_ROOT', message: 'Uma classe não tem pai.' })
  if (account.level !== 'CLASS' && !parent)
    issues.push({
      path: 'parentId',
      code: 'PARENT_REQUIRED',
      message: 'Contas e subcontas pertencem a uma classe ou conta.',
    })
  if (parent) {
    if (parent.level === 'SUBACCOUNT' && account.level !== 'SUBACCOUNT')
      issues.push({
        path: 'level',
        code: 'LEVEL_ORDER',
        message: 'Abaixo de uma subconta só há subcontas.',
      })
    if (parent.level === 'CLASS' && account.level === 'CLASS')
      issues.push({ path: 'level', code: 'LEVEL_ORDER', message: 'Nível inválido.' })
    if (!account.code.startsWith(parent.code) || account.code === parent.code)
      issues.push({
        path: 'code',
        code: 'CODE_PREFIX',
        message: `O código tem de começar por ${parent.code} e ser mais longo.`,
      })
    if (parent.postable)
      issues.push({
        path: 'parentId',
        code: 'PARENT_POSTABLE',
        message: 'Uma conta movimentável não pode ter subcontas.',
      })
  }
  return issues
}

export interface PeriodDraft {
  number: number
  kind: 'OPENING' | 'NORMAL' | 'CLOSING'
  name: string
  startDate: string
  endDate: string
}

const iso = (d: Date) => d.toISOString().slice(0, 10)
const MONTHS = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez']

/**
 * Períodos de um exercício: abertura (0, no primeiro dia), um por mês civil (cortado nas datas do exercício) e
 * regularizações (último, no último dia). Exercícios de 1 a 24 meses (primeiro exercício irregular).
 */
export function buildPeriods(startDate: string, endDate: string): PeriodDraft[] | null {
  const start = new Date(`${startDate}T00:00:00Z`)
  const end = new Date(`${endDate}T00:00:00Z`)
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) return null
  const out: PeriodDraft[] = [
    { number: 0, kind: 'OPENING', name: 'Abertura', startDate, endDate: startDate },
  ]
  let cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1))
  while (cursor <= end) {
    const monthEnd = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 0))
    const from = cursor < start ? start : cursor
    const to = monthEnd > end ? end : monthEnd
    out.push({
      number: out.length,
      kind: 'NORMAL',
      name: `${MONTHS[cursor.getUTCMonth()]} ${cursor.getUTCFullYear()}`,
      startDate: iso(from),
      endDate: iso(to),
    })
    cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1))
  }
  if (out.length - 1 > 24) return null
  out.push({
    number: out.length,
    kind: 'CLOSING',
    name: 'Regularizações',
    startDate: endDate,
    endDate,
  })
  return out
}

export interface LineInput {
  accountId?: unknown
  description?: unknown
  debit?: unknown
  credit?: unknown
  costCenterId?: unknown
  thirdPartyRef?: unknown
}

export interface Line {
  lineNo: number
  accountId: string
  description: string | null
  debit: bigint
  credit: bigint
  costCenterId: string | null
  thirdPartyRef: string | null
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const optionalText = (v: unknown, max: number) =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null

/**
 * Forma das linhas (também em rascunho): conta indicada, um só lado, valor positivo com no máximo `scale` casas.
 * Valores lidos como texto decimal com no máximo `scale` casas (precisão da empresa) e devolvidos na escala de
 * armazenamento (`STORAGE_SCALE`).
 */
export function normalizeLines(raw: unknown, scale: number) {
  const issues: ErrorDetail[] = []
  const lines: Line[] = []
  if (!Array.isArray(raw)) {
    issues.push({ path: 'lines', code: 'INVALID', message: 'Lista de linhas.' })
    return { lines, issues }
  }
  if (raw.length > 500)
    issues.push({ path: 'lines', code: 'TOO_MANY', message: 'No máximo 500 linhas.' })
  raw.slice(0, 500).forEach((item: LineInput, i) => {
    const path = `lines.${i}`
    const accountId = typeof item?.accountId === 'string' ? item.accountId : ''
    if (!UUID.test(accountId))
      issues.push({ path: `${path}.accountId`, code: 'REQUIRED', message: 'Indique a conta.' })
    const blank = (v: unknown) => v === undefined || v === null || v === '' || v === '0'
    const debit = blank(item?.debit) ? 0n : parseDecimal(item.debit, scale)
    const credit = blank(item?.credit) ? 0n : parseDecimal(item.credit, scale)
    if (debit === null || credit === null) {
      issues.push({
        path: `${path}.${debit === null ? 'debit' : 'credit'}`,
        code: 'INVALID_AMOUNT',
        message: `Valor positivo com até ${scale} casas decimais.`,
      })
      return
    }
    if (debit > 0n === credit > 0n)
      issues.push({
        path: `${path}.debit`,
        code: 'ONE_SIDE',
        message: 'Cada linha tem valor a débito ou a crédito (só um, maior que zero).',
      })
    const costCenterId =
      typeof item?.costCenterId === 'string' && item.costCenterId ? item.costCenterId : null
    if (costCenterId && !UUID.test(costCenterId))
      issues.push({
        path: `${path}.costCenterId`,
        code: 'INVALID',
        message: 'Centro de custo inválido.',
      })
    const up = 10n ** BigInt(STORAGE_SCALE - scale)
    lines.push({
      lineNo: i + 1,
      accountId,
      description: optionalText(item?.description, 300),
      debit: debit * up,
      credit: credit * up,
      costCenterId,
      thirdPartyRef: optionalText(item?.thirdPartyRef, 60),
    })
  })
  return { lines, issues }
}

export interface AccountFacts {
  id: string
  chartId: string
  code: string
  postable: boolean
  status: string
  requiresCostCenter: boolean
  requiresThirdParty: boolean
}

/**
 * Regras para submeter/contabilizar: pelo menos duas linhas; contas movimentáveis e activas do plano do lançamento;
 * centro de custo e terceiro quando a conta os exige; débito = crédito na moeda do lançamento **e** na moeda funcional
 * (depois de convertido e arredondado linha a linha).
 */
export function checkBalancedEntry(
  lines: Line[],
  accounts: Map<string, AccountFacts>,
  chartId: string,
  conversion: { rate: bigint; scale: number; rounding: Rounding }
) {
  const issues: ErrorDetail[] = []
  if (lines.length < 2)
    issues.push({
      path: 'lines',
      code: 'MIN_LINES',
      message: 'Um lançamento tem pelo menos duas linhas.',
    })
  let debit = 0n
  let credit = 0n
  let debitF = 0n
  let creditF = 0n
  const functional = lines.map((l, i) => {
    const a = accounts.get(l.accountId)
    const path = `lines.${i}.accountId`
    if (!a || a.chartId !== chartId)
      issues.push({
        path,
        code: 'ACCOUNT_NOT_FOUND',
        message: 'A conta não é do plano desta entidade.',
      })
    else {
      if (!a.postable)
        issues.push({
          path,
          code: 'NOT_POSTABLE',
          message: `A conta ${a.code} não é movimentável.`,
        })
      if (a.status !== 'ACTIVE')
        issues.push({ path, code: 'ACCOUNT_INACTIVE', message: `A conta ${a.code} está inactiva.` })
      if (a.requiresCostCenter && !l.costCenterId)
        issues.push({
          path: `lines.${i}.costCenterId`,
          code: 'COST_CENTER_REQUIRED',
          message: `A conta ${a.code} exige centro de custo.`,
        })
      if (a.requiresThirdParty && !l.thirdPartyRef)
        issues.push({
          path: `lines.${i}.thirdPartyRef`,
          code: 'THIRD_PARTY_REQUIRED',
          message: `A conta ${a.code} exige terceiro.`,
        })
    }
    const df = multiply(
      l.debit,
      STORAGE_SCALE,
      conversion.rate,
      RATE_SCALE,
      conversion.scale,
      conversion.rounding
    )
    const cf = multiply(
      l.credit,
      STORAGE_SCALE,
      conversion.rate,
      RATE_SCALE,
      conversion.scale,
      conversion.rounding
    )
    debit += l.debit
    credit += l.credit
    debitF += df
    creditF += cf
    return { debitFunctional: df, creditFunctional: cf }
  })
  if (debit !== credit)
    issues.push({
      path: 'lines',
      code: 'UNBALANCED',
      message: `Débito (${formatDecimal(debit, STORAGE_SCALE)}) diferente do crédito (${formatDecimal(credit, STORAGE_SCALE)}).`,
    })
  else if (debitF !== creditF)
    issues.push({
      path: 'lines',
      code: 'UNBALANCED_FUNCTIONAL',
      message: `Depois da conversão para a moeda funcional, débito (${formatDecimal(debitF, conversion.scale)}) e crédito (${formatDecimal(creditF, conversion.scale)}) diferem por arredondamento; ajuste as linhas.`,
    })
  return { issues, functional, totalFunctional: debitF, functionalScale: conversion.scale }
}
