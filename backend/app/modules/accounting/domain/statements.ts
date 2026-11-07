import type { ErrorDetail } from '#shared/http/api_error'

/**
 * Demonstrações financeiras (puro). Um modelo é uma lista de linhas: títulos, linhas de contas (por prefixos de
 * código, com regra de saldo devedor/credor), totais (fórmula sobre códigos de outras linhas) e o resultado líquido.
 * Cada conta vai para UMA linha — a do prefixo mais longo que aceita o sinal do saldo —, por isso nada é contado duas
 * vezes; o que não tem linha aparece como "não mapeado" e a demonstração não confere.
 */
export const STATEMENT_KINDS = ['BALANCE_SHEET', 'INCOME_STATEMENT'] as const
export type StatementKind = (typeof STATEMENT_KINDS)[number]
export const LINE_KINDS = ['HEADER', 'ACCOUNTS', 'TOTAL', 'NET_INCOME'] as const
export type LineKind = (typeof LINE_KINDS)[number]
export const BALANCE_RULES = ['ANY', 'DEBIT', 'CREDIT'] as const
export type BalanceRule = (typeof BALANCE_RULES)[number]

/** Naturezas das contas que cada demonstração tem de cobrir. */
export const SCOPE: Record<StatementKind, string[]> = {
  BALANCE_SHEET: ['ASSET', 'LIABILITY', 'EQUITY'],
  INCOME_STATEMENT: ['REVENUE', 'EXPENSE'],
}
export const PROFIT_NATURES = ['REVENUE', 'EXPENSE']

export interface TemplateLine {
  lineNo: number
  code: string | null
  label: string
  kind: LineKind
  sign: 1 | -1
  formula: string | null
  noteRef: string | null
}

export interface Mapping {
  lineCode: string
  prefix: string
  rule: BalanceRule
}

const CODE = /^[A-Za-z0-9_.]{1,20}$/
const PREFIX = /^[0-9A-Za-z.]{1,30}$/

/** "A1+A2-A3" → termos com sinal. Null se a sintaxe for inválida. */
export function parseFormula(raw: string): { code: string; sign: 1 | -1 }[] | null {
  // Espaços só à volta dos operadores: "A1 A2" não é "A1A2".
  if (!/^\s*[+-]?\s*[A-Za-z0-9_.]{1,20}(\s*[+-]\s*[A-Za-z0-9_.]{1,20})*\s*$/.test(raw)) return null
  const terms: { code: string; sign: 1 | -1 }[] = []
  for (const m of raw.matchAll(/([+-]?)\s*([A-Za-z0-9_.]{1,20})/g))
    terms.push({ code: m[2], sign: m[1] === '-' ? -1 : 1 })
  return terms
}

const ruleAccepts = (rule: BalanceRule, balance: bigint) =>
  rule === 'ANY' || (rule === 'DEBIT' ? balance >= 0n : balance <= 0n)

/**
 * Linha de uma conta com este saldo: o prefixo mais longo que casa com o código e aceita o sinal do saldo. Saldo
 * zero aceita qualquer regra. Null se nenhuma linha a cobrir.
 */
export function lineFor(accountCode: string, balance: bigint, mappings: Mapping[]) {
  let best: Mapping | null = null
  for (const m of mappings)
    if (accountCode.startsWith(m.prefix) && ruleAccepts(m.rule, balance))
      if (!best || m.prefix.length > best.prefix.length) best = m
  return best?.lineCode ?? null
}

/** Valida as linhas e os mapeamentos de um modelo antes de o gravar/publicar. */
export function validateTemplate(kind: StatementKind, lines: TemplateLine[], mappings: Mapping[]) {
  const issues: ErrorDetail[] = []
  const codes = new Map<string, TemplateLine>()
  lines.forEach((l, i) => {
    if (!LINE_KINDS.includes(l.kind))
      issues.push({ path: `lines.${i}.kind`, code: 'INVALID', message: 'Tipo de linha inválido.' })
    if (!l.label || l.label.length > 200)
      issues.push({
        path: `lines.${i}.label`,
        code: 'REQUIRED',
        message: 'Texto da linha (até 200).',
      })
    if (l.kind !== 'HEADER') {
      if (!l.code || !CODE.test(l.code))
        issues.push({
          path: `lines.${i}.code`,
          code: 'REQUIRED',
          message: 'Código da linha (até 20).',
        })
      else if (codes.has(l.code))
        issues.push({
          path: `lines.${i}.code`,
          code: 'DUPLICATE',
          message: `Código ${l.code} repetido.`,
        })
      else codes.set(l.code, l)
    }
    if (l.kind === 'TOTAL' && !parseFormula(l.formula ?? ''))
      issues.push({
        path: `lines.${i}.formula`,
        code: 'INVALID',
        message: 'Fórmula: códigos somados ou subtraídos (A1+A2-A3).',
      })
    if (l.kind === 'NET_INCOME' && kind !== 'BALANCE_SHEET')
      issues.push({
        path: `lines.${i}.kind`,
        code: 'INVALID',
        message: 'O resultado líquido só entra no balanço.',
      })
  })
  if (lines.filter((l) => l.kind === 'NET_INCOME').length > 1)
    issues.push({ path: 'lines', code: 'DUPLICATE', message: 'Só uma linha de resultado líquido.' })
  // Referências das fórmulas existem e não há ciclos.
  lines.forEach((l, i) => {
    if (l.kind !== 'TOTAL') return
    for (const t of parseFormula(l.formula ?? '') ?? [])
      if (!codes.has(t.code))
        issues.push({
          path: `lines.${i}.formula`,
          code: 'UNKNOWN_LINE',
          message: `A linha ${t.code} não existe.`,
        })
  })
  if (issues.length === 0 && hasCycle(lines))
    issues.push({ path: 'lines', code: 'CYCLE', message: 'Há totais que dependem de si próprios.' })
  mappings.forEach((m, i) => {
    const line = codes.get(m.lineCode)
    if (!line || line.kind !== 'ACCOUNTS')
      issues.push({
        path: `mappings.${i}.lineCode`,
        code: 'INVALID',
        message: 'Só linhas de contas recebem prefixos.',
      })
    if (!PREFIX.test(m.prefix))
      issues.push({
        path: `mappings.${i}.prefix`,
        code: 'INVALID',
        message: 'Prefixo de código de conta.',
      })
    if (!BALANCE_RULES.includes(m.rule))
      issues.push({
        path: `mappings.${i}.rule`,
        code: 'INVALID',
        message: 'Saldo qualquer, devedor ou credor.',
      })
  })
  // O mesmo prefixo em duas linhas com regras que se sobrepõem contaria duas vezes a mesma conta.
  for (let i = 0; i < mappings.length; i++)
    for (let j = i + 1; j < mappings.length; j++) {
      const a = mappings[i]
      const b = mappings[j]
      if (a.prefix === b.prefix && (a.rule === 'ANY' || b.rule === 'ANY' || a.rule === b.rule))
        issues.push({
          path: `mappings.${j}.prefix`,
          code: 'AMBIGUOUS',
          message: `O prefixo ${b.prefix} já está noutra linha para o mesmo saldo.`,
        })
    }
  return issues
}

function hasCycle(lines: TemplateLine[]) {
  const deps = new Map(
    lines
      .filter((l) => l.code)
      .map((l) => [
        l.code!,
        l.kind === 'TOTAL' ? (parseFormula(l.formula ?? '') ?? []).map((t) => t.code) : [],
      ])
  )
  const state = new Map<string, 1 | 2>()
  const visit = (c: string): boolean => {
    if (state.get(c) === 1) return true
    if (state.get(c) === 2) return false
    state.set(c, 1)
    for (const d of deps.get(c) ?? []) if (visit(d)) return true
    state.set(c, 2)
    return false
  }
  return [...deps.keys()].some(visit)
}

/**
 * Valores das linhas: contas = soma bruta (débito − crédito) das contas atribuídas × sinal; resultado líquido = soma
 * bruta das contas de resultados × sinal; totais = fórmula sobre os valores (já com sinal) das outras linhas.
 */
export function computeLines(
  lines: TemplateLine[],
  rawByLine: Map<string, bigint>,
  netIncomeRaw: bigint
) {
  const byCode = new Map(lines.filter((l) => l.code).map((l) => [l.code!, l]))
  const values = new Map<string, bigint>()
  const value = (code: string): bigint => {
    if (values.has(code)) return values.get(code)!
    const l = byCode.get(code)!
    let v = 0n
    if (l.kind === 'ACCOUNTS') v = (rawByLine.get(code) ?? 0n) * BigInt(l.sign)
    else if (l.kind === 'NET_INCOME') v = netIncomeRaw * BigInt(l.sign)
    else if (l.kind === 'TOTAL')
      v = (parseFormula(l.formula ?? '') ?? []).reduce(
        (s, t) => s + value(t.code) * BigInt(t.sign),
        0n
      )
    values.set(code, v)
    return v
  }
  for (const code of byCode.keys()) value(code)
  return values
}
