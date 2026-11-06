import type { ErrorDetail } from '#shared/http/api_error'
import { parseDecimal } from '#modules/accounting/domain/decimal'

/**
 * Motor de contabilização (puro): de um evento de negócio (origem, evento, montantes nomeados) e das linhas de uma
 * regra configurada pela empresa, produz as linhas do lançamento. As contas vêm sempre da regra, nunca do código.
 */
export const SOURCE = /^[A-Z][A-Z0-9_]{1,29}$/
export const EVENT = /^[A-Z][A-Z0-9_]{1,39}$/
export const AMOUNT_KEY = /^[a-z][a-zA-Z0-9_]{0,39}$/

export interface RuleLine {
  lineNo: number
  side: 'DEBIT' | 'CREDIT'
  accountId: string
  amountKey: string
  description: string | null
  costCenterId: string | null
  useEventCostCenter: boolean
  useEventThirdParty: boolean
}

export interface PostingEvent {
  source: string
  event: string
  sourceRef: string
  amounts: Record<string, unknown>
  costCenterId?: string | null
  thirdPartyRef?: string | null
}

/** Substitui `{source}`, `{event}` e `{sourceRef}` num texto da regra. */
export function fillTemplate(
  template: string,
  e: Pick<PostingEvent, 'source' | 'event' | 'sourceRef'>
) {
  return template
    .replaceAll('{source}', e.source)
    .replaceAll('{event}', e.event)
    .replaceAll('{sourceRef}', e.sourceRef)
}

/**
 * Linhas do lançamento: cada linha da regra vai buscar o seu montante (`amountKey`) ao evento. Montante em falta ou
 * inválido é erro (não se inventa zero); montante zero omite a linha (p. ex. imposto zero). O equilíbrio é verificado
 * depois, pelas mesmas regras de qualquer lançamento.
 */
export function buildLines(rule: RuleLine[], e: PostingEvent, scale: number) {
  const issues: ErrorDetail[] = []
  const lines: Record<string, unknown>[] = []
  for (const r of [...rule].sort((a, b) => a.lineNo - b.lineNo)) {
    const raw = e.amounts[r.amountKey]
    if (raw === undefined || raw === null || raw === '') {
      issues.push({
        path: `amounts.${r.amountKey}`,
        code: 'AMOUNT_MISSING',
        message: `O evento não traz o montante "${r.amountKey}" pedido pela linha ${r.lineNo} da regra.`,
      })
      continue
    }
    const value = parseDecimal(raw, scale)
    if (value === null) {
      issues.push({
        path: `amounts.${r.amountKey}`,
        code: 'INVALID_AMOUNT',
        message: `Montante "${r.amountKey}" inválido (decimal positivo com até ${scale} casas).`,
      })
      continue
    }
    if (value === 0n) continue
    const amount = String(raw).trim()
    lines.push({
      accountId: r.accountId,
      description: r.description ? fillTemplate(r.description, e) : null,
      debit: r.side === 'DEBIT' ? amount : null,
      credit: r.side === 'CREDIT' ? amount : null,
      costCenterId: r.useEventCostCenter ? (e.costCenterId ?? null) : r.costCenterId,
      thirdPartyRef: r.useEventThirdParty ? (e.thirdPartyRef ?? null) : null,
    })
  }
  return { lines, issues }
}

/** Chave de idempotência por omissão: a mesma origem, evento e referência nunca contabilizam duas vezes. */
export const defaultKey = (e: Pick<PostingEvent, 'source' | 'event' | 'sourceRef'>) =>
  `${e.source}:${e.event}:${e.sourceRef}`.slice(0, 120)
