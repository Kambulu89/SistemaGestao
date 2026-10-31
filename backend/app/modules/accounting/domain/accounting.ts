import { MONEY_SCALE, fromScaled, toScaled } from '#core/decimal/index'

/**
 * Contabilidade geral (ERP E1): plano de contas, exercícios e períodos, lançamentos de partidas dobradas. Tudo aqui é
 * puro e exacto (inteiros escalados, nunca `number`). A base de dados repete as garantias essenciais (equilíbrio e
 * imutabilidade por trigger); estas funções dão as mensagens úteis antes de lá chegar.
 */

export const NATURES = ['DEBIT', 'CREDIT'] as const
export type Nature = (typeof NATURES)[number]

export const ACCOUNT_KINDS = ['HEADER', 'POSTING'] as const
export type AccountKind = (typeof ACCOUNT_KINDS)[number]

export const JOURNAL_TYPES = [
  'GENERAL',
  'SALES',
  'PURCHASES',
  'TREASURY',
  'PAYROLL',
  'OPENING',
  'CLOSING',
] as const
export type JournalType = (typeof JOURNAL_TYPES)[number]

export const ENTRY_STATUSES = ['DRAFT', 'POSTED', 'REVERSED'] as const
export type EntryStatus = (typeof ENTRY_STATUSES)[number]

export const MAX_LINES = 500
export const MAX_PERIODS = 24

export interface Issue {
  path: string
  code: string
  message: string
}

// --- plano de contas ---------------------------------------------------------------------------------

const CODE = /^[1-9]\d*(\.\d+)*$/

export const isAccountCode = (code: unknown): code is string =>
  typeof code === 'string' && code.length <= 20 && CODE.test(code)

/** A classe é o primeiro algarismo (no PGC angolano: 1 a 8). */
export const classOf = (code: string): number => Number(code[0])

/** `parent` pode ser mãe de `child`? Tem de ser um prefixo próprio do código (31 → 31.1 → 31.1.2; 3 → 31). */
export const isParentCode = (parent: string, child: string): boolean =>
  child.length > parent.length && child.startsWith(parent)

/**
 * Modelo de partida: as oito classes do Plano Geral de Contabilidade angolano, só como contas de cabeçalho. As
 * subcontas criam-se e validam-se por quem conhece a empresa (um contabilista): o modelo não as presume.
 */
export const PGC_CLASSES: readonly { code: string; name: string; nature: Nature }[] = [
  { code: '1', name: 'Meios fixos e investimentos', nature: 'DEBIT' },
  { code: '2', name: 'Existências', nature: 'DEBIT' },
  { code: '3', name: 'Terceiros', nature: 'DEBIT' },
  { code: '4', name: 'Meios monetários', nature: 'DEBIT' },
  { code: '5', name: 'Capital e reservas', nature: 'CREDIT' },
  { code: '6', name: 'Proveitos e ganhos por natureza', nature: 'CREDIT' },
  { code: '7', name: 'Custos e perdas por natureza', nature: 'DEBIT' },
  { code: '8', name: 'Resultados', nature: 'CREDIT' },
]

// --- exercícios e períodos ---------------------------------------------------------------------------

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

export const isIsoDate = (value: unknown): value is string => {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return false
  const date = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}

const addDays = (iso: string, days: number): string => {
  const date = new Date(`${iso}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

const lastDayOfMonth = (iso: string): string => {
  const date = new Date(`${iso.slice(0, 7)}-01T00:00:00Z`)
  date.setUTCMonth(date.getUTCMonth() + 1)
  date.setUTCDate(0)
  return date.toISOString().slice(0, 10)
}

export interface PeriodDraft {
  number: number
  startsOn: string
  endsOn: string
}

/**
 * Períodos mensais de um exercício: o primeiro começa no início do exercício e cada um acaba no fim do mês civil (ou no
 * fim do exercício). Um exercício tem entre 1 e 24 meses, para cobrir exercícios irregulares de arranque ou de mudança.
 */
export function periodsOf(
  startsOn: string,
  endsOn: string
): { periods: PeriodDraft[] } | { issue: Issue } {
  if (!isIsoDate(startsOn) || !isIsoDate(endsOn))
    return {
      issue: { path: 'startsOn', code: 'INVALID', message: 'Datas inválidas (AAAA-MM-DD).' },
    }
  if (endsOn < startsOn)
    return {
      issue: {
        path: 'endsOn',
        code: 'INVALID_RANGE',
        message: 'O fim tem de ser depois do início.',
      },
    }
  const periods: PeriodDraft[] = []
  let cursor = startsOn
  while (cursor <= endsOn) {
    if (periods.length >= MAX_PERIODS)
      return {
        issue: {
          path: 'endsOn',
          code: 'TOO_LONG',
          message: `Um exercício tem no máximo ${MAX_PERIODS} meses.`,
        },
      }
    const monthEnd = lastDayOfMonth(cursor)
    const end = monthEnd < endsOn ? monthEnd : endsOn
    periods.push({ number: periods.length + 1, startsOn: cursor, endsOn: end })
    cursor = addDays(end, 1)
  }
  return { periods }
}

// --- lançamentos -------------------------------------------------------------------------------------

export interface LineInput {
  accountId: string
  debit: string
  credit: string
  description: string | null
  costCenterId: string | null
  partyId: string | null
}

export interface BalancedLines {
  lines: LineInput[]
  totalDebit: string
  totalCredit: string
}

const amount = (value: unknown): bigint | null => {
  if (value === undefined || value === null || value === '') return 0n
  if (typeof value !== 'string') return null
  return toScaled(value, MONEY_SCALE)
}

/**
 * As linhas de um lançamento: cada uma tem débito **ou** crédito positivo (nunca os dois, nunca zero), e o total dos
 * débitos é igual ao dos créditos. `requireBalance` é falso nos rascunhos (que se guardam a meio), verdadeiro ao lançar.
 */
export function validateLines(
  raw: unknown,
  requireBalance: boolean
): { value: BalancedLines } | { issues: Issue[] } {
  if (!Array.isArray(raw))
    return {
      issues: [{ path: 'lines', code: 'REQUIRED', message: 'Indique as linhas do lançamento.' }],
    }
  if (raw.length > MAX_LINES)
    return {
      issues: [
        {
          path: 'lines',
          code: 'TOO_MANY',
          message: `Um lançamento tem no máximo ${MAX_LINES} linhas.`,
        },
      ],
    }
  const issues: Issue[] = []
  const lines: LineInput[] = []
  let debit = 0n
  let credit = 0n
  raw.forEach((item: unknown, i: number) => {
    const line = (item ?? {}) as Record<string, unknown>
    const d = amount(line['debit'])
    const c = amount(line['credit'])
    if (typeof line['accountId'] !== 'string' || line['accountId'] === '')
      issues.push({ path: `lines.${i}.accountId`, code: 'REQUIRED', message: 'Indique a conta.' })
    if (d === null || c === null) {
      issues.push({
        path: `lines.${i}.debit`,
        code: 'INVALID_AMOUNT',
        message: 'Montante inválido (até 4 casas decimais, como texto).',
      })
      return
    }
    if (d > 0n === c > 0n) {
      issues.push({
        path: `lines.${i}.debit`,
        code: 'ONE_SIDE',
        message: 'Cada linha tem um débito ou um crédito maior que zero, não os dois.',
      })
      return
    }
    debit += d
    credit += c
    const description = typeof line['description'] === 'string' ? line['description'].trim() : ''
    lines.push({
      accountId: String(line['accountId'] ?? ''),
      debit: fromScaled(d, MONEY_SCALE),
      credit: fromScaled(c, MONEY_SCALE),
      description: description === '' ? null : description.slice(0, 240),
      costCenterId: typeof line['costCenterId'] === 'string' ? line['costCenterId'] : null,
      partyId: typeof line['partyId'] === 'string' ? line['partyId'] : null,
    })
  })
  if (issues.length > 0) return { issues }
  if (requireBalance) {
    if (lines.length < 2)
      return {
        issues: [
          { path: 'lines', code: 'TOO_FEW', message: 'Um lançamento tem pelo menos duas linhas.' },
        ],
      }
    if (debit !== credit)
      return {
        issues: [
          {
            path: 'lines',
            code: 'UNBALANCED',
            message: `Débitos (${fromScaled(debit, MONEY_SCALE)}) e créditos (${fromScaled(credit, MONEY_SCALE)}) têm de ser iguais.`,
          },
        ],
      }
  }
  return {
    value: {
      lines,
      totalDebit: fromScaled(debit, MONEY_SCALE),
      totalCredit: fromScaled(credit, MONEY_SCALE),
    },
  }
}

/** As linhas do lançamento inverso: troca débitos e créditos, mantém contas e dimensões. */
export const reverseLines = (lines: readonly LineInput[]): LineInput[] =>
  lines.map((l) => ({ ...l, debit: l.credit, credit: l.debit }))

/** Saldo no sentido da natureza da conta: devedora = débitos − créditos; credora = créditos − débitos. */
export function natureBalance(nature: Nature, debit: string, credit: string): string {
  const d = toScaled(debit, MONEY_SCALE) ?? 0n
  const c = toScaled(credit, MONEY_SCALE) ?? 0n
  return fromScaled(nature === 'DEBIT' ? d - c : c - d, MONEY_SCALE)
}

/** Razão: saldo acumulado linha a linha (sempre débito − crédito; o sinal diz o lado). */
export function runningBalance(
  opening: string,
  rows: readonly { debit: string; credit: string }[]
): string[] {
  let balance = toScaled(opening.replace('-', ''), MONEY_SCALE) ?? 0n
  if (opening.startsWith('-')) balance = -balance
  return rows.map((r) => {
    balance += (toScaled(r.debit, MONEY_SCALE) ?? 0n) - (toScaled(r.credit, MONEY_SCALE) ?? 0n)
    return fromScaled(balance, MONEY_SCALE)
  })
}

// --- regras de contabilização ------------------------------------------------------------------------

/**
 * Eventos que os outros módulos publicam e os papéis de conta que cada um precisa. As regras dizem, por empresa, que
 * conta e diário usar em cada papel. Os produtores entram na fase E2; a configuração e o motor existem desde já.
 */
export const POSTING_EVENTS: Readonly<Record<string, { label: string; roles: readonly string[] }>> =
  {
    'invoice.issued': { label: 'Factura emitida', roles: ['receivable', 'revenue', 'tax'] },
    'credit_note.issued': {
      label: 'Nota de crédito emitida',
      roles: ['receivable', 'revenue', 'tax'],
    },
    'shipment.posted': {
      label: 'Expedição lançada (custo das vendas)',
      roles: ['cost_of_sales', 'inventory'],
    },
    'goods_receipt.posted': {
      label: 'Recepção de compra lançada',
      roles: ['inventory', 'goods_received_not_invoiced'],
    },
    'supplier_invoice.validated': {
      label: 'Factura de fornecedor validada',
      roles: ['goods_received_not_invoiced', 'expense', 'tax', 'payable'],
    },
    'payment.inbound.confirmed': {
      label: 'Recebimento confirmado',
      roles: ['treasury', 'receivable'],
    },
    'payment.outbound.confirmed': { label: 'Pagamento confirmado', roles: ['payable', 'treasury'] },
    'payroll.approved': {
      label: 'Processamento salarial aprovado',
      roles: ['salary_expense', 'salary_payable'],
    },
  }

export const isPostingEvent = (value: unknown): value is string =>
  typeof value === 'string' && value in POSTING_EVENTS
