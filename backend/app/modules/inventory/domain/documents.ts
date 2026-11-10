import type { ErrorDetail } from '#shared/http/api_error'

/**
 * Documentos de entrada e saída (8.4). Rascunho → conferido → confirmado (parcial ou completo); o stock só muda na
 * confirmação. Cada confirmação conta as quantidades conferidas; o que falta fica para outra ronda ou fecha-se com
 * motivo. Uma confirmação pode ser estornada (o documento volta a ter saldo por confirmar).
 */
export const DOC_TYPES = ['RECEIPT', 'ISSUE'] as const
export type DocType = (typeof DOC_TYPES)[number]
export const DOC_STATUSES = ['DRAFT', 'CHECKED', 'PARTIAL', 'COMPLETED', 'CANCELLED'] as const
export type DocStatus = (typeof DOC_STATUSES)[number]

export const ORIGINS: Record<DocType, readonly string[]> = {
  RECEIPT: ['PURCHASE', 'RETURN', 'PRODUCTION', 'OPENING', 'OTHER'],
  ISSUE: ['CONSUMPTION', 'SALE', 'LOSS', 'RETURN', 'SAMPLE', 'OTHER'],
}
export const LINE_BUCKETS = ['UNRESTRICTED', 'BLOCKED', 'QUARANTINE'] as const
export type LineBucket = (typeof LINE_BUCKETS)[number]

/** Tipo de documento da série documental (configurada pela empresa em Séries documentais). */
export const SERIES_TYPE: Record<DocType, string> = {
  RECEIPT: 'STOCK_RECEIPT',
  ISSUE: 'STOCK_ISSUE',
}

export const isLotCode = (v: unknown): v is string =>
  typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,39}$/.test(v)

/** Números de série: aparados, sem vazios nem repetidos (sem distinguir maiúsculas). */
export function normalizeSerials(raw: unknown): string[] | null {
  if (raw === null || raw === undefined) return []
  if (!Array.isArray(raw)) return null
  const out: string[] = []
  const seen = new Set<string>()
  for (const s of raw) {
    if (typeof s !== 'string') return null
    const t = s.trim()
    if (!t || t.length > 60 || seen.has(t.toUpperCase())) return null
    seen.add(t.toUpperCase())
    out.push(t)
  }
  return out
}

export interface LineFacts {
  docType: DocType
  trackLots: boolean
  trackSerials: boolean
  trackExpiry: boolean
  lotCode: string | null
  serials: string[]
  expiryDate: string | null
  /** Quantidade base (6 casas, escalada). */
  baseQuantity: bigint
  unitCost: bigint | null
}

/** Rastreabilidade e custo de uma linha. */
export function lineIssues(l: LineFacts, at: string): ErrorDetail[] {
  const issues: ErrorDetail[] = []
  const add = (path: string, code: string, message: string) =>
    issues.push({ path: `${at}.${path}`, code, message })
  if (l.trackLots && !l.lotCode)
    add('lotCode', 'REQUIRED', 'Este produto controla lotes: indique o lote.')
  if (!l.trackLots && l.lotCode) add('lotCode', 'NOT_TRACKED', 'Este produto não controla lotes.')
  if (l.trackSerials) {
    const unit = 1_000_000n
    if (l.baseQuantity % unit !== 0n)
      add('quantity', 'SERIAL_DECIMALS', 'Com números de série a quantidade base é inteira.')
    else if (BigInt(l.serials.length) !== l.baseQuantity / unit)
      add(
        'serials',
        'SERIAL_COUNT',
        `Indique ${l.baseQuantity / unit} número(s) de série (um por unidade base).`
      )
  } else if (l.serials.length) add('serials', 'NOT_TRACKED', 'Este produto não controla séries.')
  if (l.docType === 'RECEIPT' && l.trackExpiry && !l.expiryDate)
    add('expiryDate', 'REQUIRED', 'Este produto controla validade: indique a data.')
  if (!l.trackExpiry && l.expiryDate)
    add('expiryDate', 'NOT_TRACKED', 'Este produto não controla validade.')
  if (l.docType === 'ISSUE' && l.unitCost !== null)
    add('unitCost', 'NOT_ALLOWED', 'O custo das saídas vem da valorização do stock.')
  return issues
}

/** Estado a partir das quantidades: tudo confirmado → concluído; algo confirmado (ou já houve confirmações) → parcial. */
export function statusFrom(
  lines: { quantity: bigint; confirmed: bigint }[],
  hadConfirmations: boolean
): DocStatus {
  if (lines.length && lines.every((l) => l.confirmed === l.quantity)) return 'COMPLETED'
  if (hadConfirmations || lines.some((l) => l.confirmed > 0n)) return 'PARTIAL'
  return 'DRAFT'
}

/** Quantidade conferida de uma ronda: 0 ≤ conferida ≤ por confirmar; com séries, nada ou tudo o que falta. */
export function checkedIssue(
  checked: bigint,
  remaining: bigint,
  trackSerials: boolean
): string | null {
  if (checked < 0n) return 'A quantidade conferida não pode ser negativa.'
  if (checked > remaining) return 'Conferido acima do que falta confirmar nesta linha.'
  if (trackSerials && checked !== 0n && checked !== remaining)
    return 'Linhas com números de série confirmam-se por inteiro.'
  return null
}

/** O que cada estado permite. */
export const CAN: Record<
  'edit' | 'check' | 'reopen' | 'confirm' | 'close' | 'cancel',
  readonly DocStatus[]
> = {
  edit: ['DRAFT'],
  check: ['DRAFT', 'PARTIAL'],
  reopen: ['CHECKED'],
  confirm: ['CHECKED'],
  close: ['PARTIAL'],
  cancel: ['DRAFT', 'CHECKED'],
}
