import type { ErrorDetail } from '#shared/http/api_error'
import { divRound, parseScaled, scaledText } from '#modules/sales/domain/pricing'

/*
 * Motor fiscal (10.5) — regras puras. Nada de valores legais aqui: as taxas, isenções e retenções vêm da configuração
 * da empresa (confirmada por outra pessoa, com fonte legal).
 *
 * Cálculo (inteiros escalados, arredondamento a metade para cima):
 *  - imposto de uma linha = base × taxa / 100. Arredondamento por LINHA: cada imposto de cada linha a 2 casas e o
 *    documento soma-os. Por DOCUMENTO: as linhas guardam o valor exacto (6 casas) e o total de cada imposto/taxa é
 *    arredondado uma vez a 2 casas.
 *  - retenção: sobre a soma das bases do documento sujeitas a essa retenção, se atingir a base mínima configurada;
 *    arredondada a 2 casas.
 *  - totais: líquido, imposto, bruto = líquido + imposto, retenção, a pagar = bruto − retenção.
 */

export const TAX_KINDS = ['TAX', 'WITHHOLDING'] as const
export const TAX_TYPES = ['VAT', 'STAMP', 'INCOME', 'OTHER'] as const
export const ROUNDING_LEVELS = ['LINE', 'DOCUMENT'] as const
export type RoundingLevel = (typeof ROUNDING_LEVELS)[number]
export const DOCUMENT_KINDS = [
  'INVOICE',
  'INVOICE_RECEIPT',
  'CREDIT_NOTE',
  'DEBIT_NOTE',
  'RECEIPT',
] as const
export type DocumentKind = (typeof DOCUMENT_KINDS)[number]

const DATE = /^\d{4}-\d{2}-\d{2}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const CODE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,19}$/
const text = (v: unknown) => (typeof v === 'string' ? v.trim() : v)
const optional = (v: unknown) => {
  const t = text(v)
  return t === '' || t === undefined || t === null ? null : t
}
const len = (
  input: Record<string, unknown>,
  k: string,
  min: number,
  max: number,
  label: string,
  issues: ErrorDetail[],
  v: Record<string, unknown>,
  creating: boolean
) => {
  if (!(k in input) && !creating) return
  const t = text(input[k])
  if (typeof t !== 'string' || t.length < min || t.length > max)
    issues.push({ path: k, code: 'LENGTH', message: `${label}: ${min} a ${max} caracteres.` })
  else v[k] = t
}

export function normalizeTaxCode(input: Record<string, unknown>, creating: boolean) {
  const issues: ErrorDetail[] = []
  const v: Record<string, unknown> = {}
  if ('countryCode' in input || creating) {
    const c = typeof input.countryCode === 'string' ? input.countryCode.trim().toUpperCase() : ''
    if (!/^[A-Z]{2}$/.test(c))
      issues.push({
        path: 'countryCode',
        code: 'INVALID',
        message: 'País: código ISO de 2 letras.',
      })
    else v.countryCode = c
  }
  if ('code' in input || creating) {
    const c = text(input.code)
    if (typeof c !== 'string' || !CODE.test(c))
      issues.push({
        path: 'code',
        code: 'INVALID_CODE',
        message: 'Código: até 20 letras, dígitos ou . _ / -.',
      })
    else v.code = c.toUpperCase()
  }
  len(input, 'name', 2, 120, 'Nome', issues, v, creating)
  if ('kind' in input || creating) {
    if (!(TAX_KINDS as readonly unknown[]).includes(input.kind))
      issues.push({ path: 'kind', code: 'INVALID', message: 'Imposto ou retenção.' })
    else v.kind = input.kind
  }
  if ('taxType' in input || creating) {
    if (!(TAX_TYPES as readonly unknown[]).includes(input.taxType))
      issues.push({ path: 'taxType', code: 'INVALID', message: 'Tipo inválido.' })
    else v.taxType = input.taxType
  }
  if ('status' in input) {
    if (!['ACTIVE', 'INACTIVE'].includes(input.status as string))
      issues.push({ path: 'status', code: 'INVALID', message: 'Activo ou inactivo.' })
    else v.status = input.status
  }
  return { v, issues }
}

export function normalizeRate(input: Record<string, unknown>, creating: boolean) {
  const issues: ErrorDetail[] = []
  const v: Record<string, unknown> = {}
  if ('legalEntityId' in input) {
    const e = optional(input.legalEntityId)
    if (e !== null && (typeof e !== 'string' || !UUID.test(e)))
      issues.push({ path: 'legalEntityId', code: 'INVALID', message: 'Entidade inválida.' })
    else v.legalEntityId = e
  }
  if ('validFrom' in input || creating) {
    if (typeof input.validFrom !== 'string' || !DATE.test(input.validFrom))
      issues.push({ path: 'validFrom', code: 'INVALID', message: 'Data de início obrigatória.' })
    else v.validFrom = input.validFrom
  }
  if ('validTo' in input) {
    const d = optional(input.validTo)
    if (d !== null && (typeof d !== 'string' || !DATE.test(d)))
      issues.push({ path: 'validTo', code: 'INVALID', message: 'Data de fim inválida.' })
    else v.validTo = d
  }
  if (v.validFrom && v.validTo && (v.validTo as string) < (v.validFrom as string))
    issues.push({
      path: 'validTo',
      code: 'INVALID',
      message: 'O fim não pode ser antes do início.',
    })
  if ('rate' in input || creating) {
    const r = parseScaled(input.rate, 4)
    if (r === null || r > 100_0000n)
      issues.push({
        path: 'rate',
        code: 'INVALID',
        message: 'Taxa de 0 a 100, até 4 casas, em texto.',
      })
    else v.rate = scaledText(r, 4)
  }
  if ('minBase' in input) {
    const raw = optional(input.minBase)
    if (raw === null) v.minBase = null
    else {
      const m = parseScaled(raw, 2)
      if (m === null)
        issues.push({ path: 'minBase', code: 'INVALID', message: 'Base mínima ≥ 0, até 2 casas.' })
      else v.minBase = scaledText(m, 2)
    }
  }
  len(
    input,
    'legalSource',
    5,
    300,
    'Fonte legal (diploma, artigo, data de publicação)',
    issues,
    v,
    creating
  )
  if ('notes' in input) {
    const n = optional(input.notes)
    if (n !== null && (typeof n !== 'string' || n.length > 500))
      issues.push({ path: 'notes', code: 'LENGTH', message: 'Até 500 caracteres.' })
    else v.notes = n
  }
  return { v, issues }
}

export function normalizeExemption(input: Record<string, unknown>, creating: boolean) {
  const issues: ErrorDetail[] = []
  const v: Record<string, unknown> = {}
  if ('countryCode' in input || creating) {
    const c = typeof input.countryCode === 'string' ? input.countryCode.trim().toUpperCase() : ''
    if (!/^[A-Z]{2}$/.test(c))
      issues.push({
        path: 'countryCode',
        code: 'INVALID',
        message: 'País: código ISO de 2 letras.',
      })
    else v.countryCode = c
  }
  if ('code' in input || creating) {
    const c = text(input.code)
    if (typeof c !== 'string' || !CODE.test(c))
      issues.push({
        path: 'code',
        code: 'INVALID_CODE',
        message: 'Código como na fonte oficial (até 20).',
      })
    else v.code = c.toUpperCase()
  }
  len(input, 'description', 3, 300, 'Descrição', issues, v, creating)
  len(input, 'legalSource', 5, 300, 'Fonte legal', issues, v, creating)
  return { v, issues }
}

export function normalizeSeries(input: Record<string, unknown>, creating: boolean) {
  const issues: ErrorDetail[] = []
  const v: Record<string, unknown> = {}
  if ('legalEntityId' in input || creating) {
    if (typeof input.legalEntityId !== 'string' || !UUID.test(input.legalEntityId))
      issues.push({ path: 'legalEntityId', code: 'REQUIRED', message: 'Entidade legal.' })
    else v.legalEntityId = input.legalEntityId
  }
  if ('documentKind' in input || creating) {
    if (!(DOCUMENT_KINDS as readonly unknown[]).includes(input.documentKind))
      issues.push({ path: 'documentKind', code: 'INVALID', message: 'Tipo de documento inválido.' })
    else v.documentKind = input.documentKind
  }
  if ('fiscalCode' in input || creating) {
    const c = text(input.fiscalCode)
    if (typeof c !== 'string' || !/^[A-Z]{1,10}$/.test(c.toUpperCase()))
      issues.push({
        path: 'fiscalCode',
        code: 'INVALID',
        message: 'Código do tipo de documento (letras, até 10), como na fonte oficial.',
      })
    else v.fiscalCode = c.toUpperCase()
  }
  if ('code' in input || creating) {
    const c = text(input.code)
    if (typeof c !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,29}$/.test(c))
      issues.push({
        path: 'code',
        code: 'INVALID_CODE',
        message: 'Código da série: até 30 letras, dígitos ou . _ / -.',
      })
    else v.code = c.toUpperCase()
  }
  if ('fiscalYear' in input || creating) {
    const y = Number(input.fiscalYear)
    if (!Number.isInteger(y) || y < 2000 || y > 2100)
      issues.push({ path: 'fiscalYear', code: 'INVALID', message: 'Ano fiscal.' })
    else v.fiscalYear = y
  }
  if ('prefix' in input || creating) {
    const p = typeof input.prefix === 'string' ? input.prefix : ''
    if (p.length < 1 || p.length > 30 || /[\n\r\t]/.test(p))
      issues.push({ path: 'prefix', code: 'LENGTH', message: 'Prefixo: 1 a 30 caracteres.' })
    else v.prefix = p
  }
  if ('padding' in input) {
    const n = Number(input.padding)
    if (!Number.isInteger(n) || n < 0 || n > 10)
      issues.push({ path: 'padding', code: 'INVALID', message: 'Dígitos de 0 a 10.' })
    else v.padding = n
  }
  if ('authorityReference' in input) {
    const r = optional(input.authorityReference)
    if (r !== null && (typeof r !== 'string' || r.length > 120))
      issues.push({ path: 'authorityReference', code: 'LENGTH', message: 'Até 120 caracteres.' })
    else v.authorityReference = r
  }
  if ('mode' in input && input.mode !== 'SIMULATION')
    issues.push({
      path: 'mode',
      code: 'NOT_AVAILABLE',
      message:
        'Só há modo de simulação: a operação real exige software certificado e a especificação oficial.',
    })
  return { v, issues }
}

export const formatFiscalNumber = (prefix: string, n: number, padding: number) =>
  `${prefix}${String(n).padStart(padding, '0')}`

/** A data de emissão não pode recuar em relação ao último documento da série, nem sair do ano fiscal. */
export function issueDateIssue(
  issueDate: string,
  lastIssueDate: string | null,
  fiscalYear: number
): string | null {
  if (!DATE.test(issueDate)) return 'Data de emissão inválida.'
  if (Number(issueDate.slice(0, 4)) !== fiscalYear) return `A série é do ano ${fiscalYear}.`
  if (lastIssueDate && issueDate < lastIssueDate)
    return `A série já tem documentos de ${lastIssueDate}: a data não pode recuar.`
  return null
}

// ---------------------------------------------------------------------------------------------------------------
// Cálculo
// ---------------------------------------------------------------------------------------------------------------

export interface EngineTax {
  codeId: string
  code: string
  kind: 'TAX' | 'WITHHOLDING'
  rate: string // 4 casas
  minBase: string | null // 2 casas
  exemptionCode: string | null
}
export interface EngineLine {
  key: string
  netAmount: string // 2 casas
  taxes: EngineTax[]
}

const ONE_HUNDRED_RATE = 100_0000n // 100 % com 4 casas

export function computeTaxes(lines: EngineLine[], rounding: RoundingLevel) {
  // Por imposto (código + taxa): base e valor exacto (escala 6) e arredondado (escala 2).
  const summary = new Map<
    string,
    {
      codeId: string
      code: string
      kind: string
      rate: string
      exemptionCode: string | null
      base: bigint
      exact: bigint
      rounded: bigint
      minBase: string | null
    }
  >()
  const outLines = lines.map((l) => {
    const net = parseScaled(l.netAmount, 2)!
    const taxes = l.taxes.map((t) => {
      const rate = parseScaled(t.rate, 4)!
      // net (escala 2) × taxa (escala 4) = imposto × 100 na escala 6, ou seja, o imposto exacto na escala 8.
      const exact = divRound(net * rate, 100n) // imposto com 6 casas (para mostrar)
      const lineRounded = divRound(net * rate, ONE_HUNDRED_RATE)
      const key = `${t.codeId}|${t.rate}|${t.exemptionCode ?? ''}`
      const s = summary.get(key) ?? {
        codeId: t.codeId,
        code: t.code,
        kind: t.kind,
        rate: t.rate,
        exemptionCode: t.exemptionCode,
        base: 0n,
        exact: 0n,
        rounded: 0n,
        minBase: t.minBase,
      }
      s.base += net
      s.exact += net * rate
      s.rounded += lineRounded
      summary.set(key, s)
      return {
        codeId: t.codeId,
        code: t.code,
        kind: t.kind,
        rate: t.rate,
        exemptionCode: t.exemptionCode,
        base: scaledText(net, 2),
        amount:
          t.kind === 'TAX' && rounding === 'LINE'
            ? scaledText(lineRounded, 2)
            : scaledText(exact, 6),
      }
    })
    return { key: l.key, netAmount: scaledText(net, 2), taxes }
  })
  const rows = [...summary.values()].map((s) => {
    let amount: bigint
    let applied = true
    if (s.kind === 'WITHHOLDING') {
      const min = s.minBase === null ? 0n : parseScaled(s.minBase, 2)!
      applied = s.base >= min
      amount = applied ? divRound(s.exact, ONE_HUNDRED_RATE) : 0n
    } else amount = rounding === 'LINE' ? s.rounded : divRound(s.exact, ONE_HUNDRED_RATE)
    return {
      codeId: s.codeId,
      code: s.code,
      kind: s.kind,
      rate: s.rate,
      exemptionCode: s.exemptionCode,
      base: scaledText(s.base, 2),
      amount: scaledText(amount, 2),
      applied,
      cents: amount,
    }
  })
  const net = lines.reduce((a, l) => a + parseScaled(l.netAmount, 2)!, 0n)
  const tax = rows.filter((r) => r.kind === 'TAX').reduce((a, r) => a + r.cents, 0n)
  const withholding = rows.filter((r) => r.kind === 'WITHHOLDING').reduce((a, r) => a + r.cents, 0n)
  return {
    rounding,
    lines: outLines,
    summary: rows.map((r) => ({ ...r, cents: undefined })),
    totals: {
      net: scaledText(net, 2),
      tax: scaledText(tax, 2),
      gross: scaledText(net + tax, 2),
      withholding: scaledText(withholding, 2),
      payable: scaledText(net + tax - withholding, 2),
    },
  }
}
