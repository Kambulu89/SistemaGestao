import { MONEY_SCALE, fromScaled, toScaled } from '#core/decimal/index'
import { isIsoDate, type Issue } from '#modules/finance/domain/finance'

/**
 * Conciliação bancária (M09, 5.2). Domínio puro: normalização do extracto importado, estado derivado de cada linha e
 * de cada movimento, validação de uma correspondência e pontuação das sugestões. Aritmética exacta em `bigint`
 * escalado; os valores atravessam a API como texto. O extracto nunca altera o livro: só se liga a movimentos existentes.
 */
export type MatchState = 'UNMATCHED' | 'PARTIAL' | 'MATCHED'

export const MAX_STATEMENT_LINES = 1000

const SIGNED_MONEY = /^-?\d{1,15}(\.\d{1,4})?$/

const issue = (path: string, code: string, message: string): Issue => ({ path, code, message })

/** Valor absoluto escalado de um decimal em texto (com ou sem sinal); `null` se não for decimal válido. */
export function absScaled(value: string): bigint | null {
  return toScaled(value.startsWith('-') ? value.slice(1) : value, MONEY_SCALE)
}

export const showScaled = (value: bigint): string => fromScaled(value, MONEY_SCALE)
export const signOf = (value: string): 1 | -1 => (value.startsWith('-') ? -1 : 1)

// --- extracto ---------------------------------------------------------------------------------------

export interface StatementLineInput {
  externalId?: unknown
  occurredOn?: unknown
  amount?: unknown
  description?: unknown
  reference?: unknown
}

export interface StatementLineValues {
  fingerprint: string
  externalId: string | null
  occurredOn: string
  amountSigned: string
  description: string | null
  reference: string | null
}

const clip = (value: unknown, max: number, path: string, issues: Issue[]): string | null => {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') {
    issues.push(issue(path, 'INVALID', 'Texto inválido.'))
    return null
  }
  const trimmed = value.trim()
  if (trimmed.length === 0) return null
  if (trimmed.length > max) {
    issues.push(issue(path, 'TOO_LONG', `No máximo ${max} caracteres.`))
    return null
  }
  return trimmed
}

/**
 * Valida as linhas de um extracto. A identidade de uma linha é o `externalId` do banco quando existe; senão, a data, o
 * valor e a descrição mais a ordem entre linhas iguais do mesmo ficheiro — assim importar o mesmo ficheiro duas vezes
 * dá as mesmas identidades (e o servidor ignora as repetidas), sem fundir duas linhas verdadeiramente iguais.
 */
export function normalizeStatement(lines: unknown): {
  values: StatementLineValues[]
  issues: Issue[]
} {
  const issues: Issue[] = []
  if (!Array.isArray(lines) || lines.length === 0) {
    return {
      values: [],
      issues: [issue('lines', 'REQUIRED', 'Indique pelo menos uma linha do extracto.')],
    }
  }
  if (lines.length > MAX_STATEMENT_LINES) {
    return {
      values: [],
      issues: [
        issue('lines', 'TOO_MANY', `No máximo ${MAX_STATEMENT_LINES} linhas por importação.`),
      ],
    }
  }
  const values: StatementLineValues[] = []
  const seenExternal = new Set<string>()
  const ordinal = new Map<string, number>()
  lines.forEach((raw: StatementLineInput, index) => {
    const path = `lines.${index}`
    const before = issues.length
    const occurredOn = raw?.occurredOn
    if (!isIsoDate(occurredOn)) {
      issues.push(issue(`${path}.occurredOn`, 'INVALID_DATE', 'Data inválida (AAAA-MM-DD).'))
    }
    const amount = raw?.amount
    let amountSigned = ''
    if (typeof amount !== 'string' || !SIGNED_MONEY.test(amount)) {
      issues.push(
        issue(`${path}.amount`, 'INVALID_AMOUNT', 'Valor inválido (até 4 casas decimais).')
      )
    } else {
      const abs = absScaled(amount) as bigint
      if (abs === 0n) {
        issues.push(issue(`${path}.amount`, 'ZERO_AMOUNT', 'O valor não pode ser zero.'))
      } else {
        amountSigned = `${signOf(amount) === -1 ? '-' : ''}${showScaled(abs)}`
      }
    }
    const description = clip(raw?.description, 500, `${path}.description`, issues)
    const reference = clip(raw?.reference, 120, `${path}.reference`, issues)
    const externalId = clip(raw?.externalId, 120, `${path}.externalId`, issues)
    if (issues.length > before) return
    if (externalId !== null) {
      if (seenExternal.has(externalId)) {
        issues.push(
          issue(
            `${path}.externalId`,
            'DUPLICATE_EXTERNAL_ID',
            'Identificador repetido no ficheiro.'
          )
        )
        return
      }
      seenExternal.add(externalId)
    }
    const base = `${occurredOn as string}|${amountSigned}|${description ?? ''}`
    const n = (ordinal.get(base) ?? 0) + 1
    ordinal.set(base, n)
    values.push({
      fingerprint: externalId !== null ? `ext:${externalId}` : `row:${base}|${n}`,
      externalId,
      occurredOn: occurredOn as string,
      amountSigned,
      description,
      reference,
    })
  })
  return { values, issues }
}

// --- estado -----------------------------------------------------------------------------------------

/** Estado derivado de uma linha ou de um movimento: valor absoluto total e soma absoluta das correspondências activas. */
export function stateOf(total: string, matched: string): MatchState {
  const t = absScaled(total) as bigint
  const m = absScaled(matched) as bigint
  if (m === 0n) return 'UNMATCHED'
  return m >= t ? 'MATCHED' : 'PARTIAL'
}

export function remainingOf(total: string, matched: string): string {
  const left = (absScaled(total) as bigint) - (absScaled(matched) as bigint)
  return showScaled(left < 0n ? 0n : left)
}

// --- correspondência --------------------------------------------------------------------------------

export interface MatchSide {
  accountId: string
  amountSigned: string
  remaining: string
}

/**
 * Valida uma correspondência: mesma conta, mesmo sentido e valor positivo que cabe no que falta a conciliar dos
 * dois lados. Sem valor pedido, concilia o máximo possível.
 */
export function planMatch(
  line: MatchSide,
  entry: MatchSide,
  requested: string | undefined
): { amount: string } | { issues: Issue[] } {
  const issues: Issue[] = []
  if (line.accountId !== entry.accountId) {
    issues.push(
      issue(
        'treasuryEntryId',
        'ACCOUNT_MISMATCH',
        'A linha do extracto e o movimento são de contas diferentes.'
      )
    )
  }
  if (signOf(line.amountSigned) !== signOf(entry.amountSigned)) {
    issues.push(
      issue('treasuryEntryId', 'DIRECTION_MISMATCH', 'Uma entrada não se concilia com uma saída.')
    )
  }
  const lineLeft = absScaled(line.remaining) as bigint
  const entryLeft = absScaled(entry.remaining) as bigint
  if (lineLeft === 0n) {
    issues.push(
      issue('statementLineId', 'LINE_FULLY_MATCHED', 'A linha do extracto já está conciliada.')
    )
  }
  if (entryLeft === 0n) {
    issues.push(issue('treasuryEntryId', 'ENTRY_FULLY_MATCHED', 'O movimento já está conciliado.'))
  }
  if (issues.length > 0) return { issues }
  const most = lineLeft < entryLeft ? lineLeft : entryLeft
  if (requested === undefined) return { amount: showScaled(most) }
  const wanted = /^\d{1,15}(\.\d{1,4})?$/.test(requested) ? absScaled(requested) : null
  if (wanted === null || wanted === 0n) {
    return { issues: [issue('amount', 'INVALID_AMOUNT', 'Indique um valor positivo.')] }
  }
  if (wanted > most) {
    return {
      issues: [
        issue(
          'amount',
          'EXCEEDS_REMAINING',
          'O valor excede o que falta conciliar na linha ou no movimento.'
        ),
      ],
    }
  }
  return { amount: showScaled(wanted) }
}

// --- sugestões --------------------------------------------------------------------------------------

export interface SuggestionEntry {
  id: string
  amountSigned: string
  remaining: string
  occurredOn: string
  reference: string | null
  description: string | null
}

export interface Suggestion {
  entryId: string
  score: number
  matchableAmount: string
  reasons: string[]
}

const DAY_MS = 86_400_000
const dayDistance = (a: string, b: string) =>
  Math.abs(Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / DAY_MS))

const normalizeText = (value: string) => value.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')

/** Janela de procura de candidatos, em dias à volta da data da linha. */
export const SUGGESTION_WINDOW_DAYS = 30
export const MAX_SUGGESTIONS = 10

/**
 * Pontua os movimentos por conciliar da mesma conta e sentido: valor igual ao que falta (60), data próxima (até 30) e
 * referência do pagamento citada no extracto (10). Valores diferentes só ficam como candidatos parciais. A decisão é
 * sempre de uma pessoa: isto só ordena.
 */
export function suggest(
  line: {
    amountSigned: string
    remaining: string
    occurredOn: string
    description: string | null
    reference: string | null
  },
  entries: readonly SuggestionEntry[]
): Suggestion[] {
  const lineLeft = absScaled(line.remaining) as bigint
  const haystack = normalizeText(`${line.description ?? ''} ${line.reference ?? ''}`)
  const result: Suggestion[] = []
  for (const entry of entries) {
    if (signOf(entry.amountSigned) !== signOf(line.amountSigned)) continue
    const entryLeft = absScaled(entry.remaining) as bigint
    if (entryLeft === 0n || lineLeft === 0n) continue
    const days = dayDistance(line.occurredOn, entry.occurredOn)
    if (days > SUGGESTION_WINDOW_DAYS) continue
    const reasons: string[] = []
    let score = 0
    if (entryLeft === lineLeft) {
      score += 60
      reasons.push('Valor igual')
    } else {
      score += 15
      reasons.push('Valor parcial')
    }
    const proximity = Math.max(0, 30 - 5 * days)
    if (proximity > 0) {
      score += proximity
      reasons.push(days === 0 ? 'Mesma data' : `${days} dia(s) de diferença`)
    }
    const needle = entry.reference ? normalizeText(entry.reference) : ''
    if (needle.length >= 3 && haystack.includes(needle)) {
      score += 10
      reasons.push('Referência no extracto')
    }
    result.push({
      entryId: entry.id,
      score,
      matchableAmount: showScaled(entryLeft < lineLeft ? entryLeft : lineLeft),
      reasons,
    })
  }
  return result
    .filter((s) => s.score >= 20)
    .sort((a, b) => b.score - a.score || a.entryId.localeCompare(b.entryId))
    .slice(0, MAX_SUGGESTIONS)
}
