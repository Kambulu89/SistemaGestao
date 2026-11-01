import { detailedErrorMessage } from '../../../core/api/error-message';
import type { AccountDto, EntryStatus, JournalDto, JournalType, Nature } from './accounting.api';

/** Contabilidade: funções puras de montantes exactos (texto ↔ inteiro escalado), árvore de contas e textos. */

export const NATURE_LABEL: Readonly<Record<Nature, string>> = {
  DEBIT: 'Devedora',
  CREDIT: 'Credora',
};

export const STATUS_LABEL: Readonly<
  Record<EntryStatus, { label: string; tone: 'neutral' | 'success' | 'warning' }>
> = {
  DRAFT: { label: 'Rascunho', tone: 'neutral' },
  POSTED: { label: 'Lançado', tone: 'success' },
  REVERSED: { label: 'Revertido', tone: 'warning' },
};

export const JOURNAL_TYPE_LABEL: Readonly<Record<JournalType, string>> = {
  GENERAL: 'Operações diversas',
  SALES: 'Vendas',
  PURCHASES: 'Compras',
  TREASURY: 'Tesouraria',
  PAYROLL: 'Salários',
  OPENING: 'Abertura',
  CLOSING: 'Apuramento',
};

export const ROLE_LABEL: Readonly<Record<string, string>> = {
  receivable: 'Clientes (a receber)',
  revenue: 'Proveitos (vendas/serviços)',
  tax: 'Impostos (IVA)',
  cost_of_sales: 'Custo das vendas',
  inventory: 'Existências',
  goods_received_not_invoiced: 'Fornecedores c/ recepções por facturar',
  expense: 'Custos',
  payable: 'Fornecedores (a pagar)',
  treasury: 'Caixa ou banco',
  salary_expense: 'Custos com pessoal',
  salary_payable: 'Remunerações a pagar',
};

const ERRORS: Readonly<Record<string, string>> = {
  UNBALANCED: 'Débitos e créditos têm de ser iguais.',
  TOO_FEW: 'Um lançamento tem pelo menos duas linhas.',
  ONE_SIDE: 'Cada linha tem um débito ou um crédito, não os dois.',
  INVALID_AMOUNT: 'Montante inválido (até 4 casas decimais).',
  NOT_POSTING: 'Use contas de movimento (não as agregadoras).',
  NO_FISCAL_YEAR: 'Não há exercício contabilístico que inclua esta data.',
  PERIOD_CLOSED: 'O período desta data está fechado.',
  ENTRY_POSTED: 'Um lançamento lançado não se altera: reverta-o.',
  ALREADY_REVERSED: 'Este lançamento já foi revertido.',
  IS_REVERSAL: 'Um lançamento inverso não se reverte.',
  ACCOUNT_CODE_TAKEN: 'Já existe uma conta com este código.',
  ACCOUNT_IN_USE: 'A conta tem movimentos, subcontas ou regras: desactive-a.',
  NOT_UNDER_PARENT: 'O código tem de começar pelo código da conta-mãe.',
  NOT_HEADER: 'A conta-mãe tem de ser agregadora.',
  FISCAL_YEAR_OVERLAP: 'O exercício sobrepõe-se a outro desta empresa.',
  FISCAL_YEAR_CODE_TAKEN: 'Já existe um exercício com este código.',
  FISCAL_YEAR_CLOSED: 'O exercício está encerrado.',
  PERIODS_OPEN: 'Feche todos os períodos antes de encerrar o exercício.',
  JOURNAL_CODE_TAKEN: 'Já existe um diário com este código.',
  STALE_VERSION: 'Os dados mudaram entretanto. Recarregue e tente de novo.',
};

export function accountingError(raw: unknown, fallback: string): string {
  const error = raw instanceof Error && raw.cause ? raw.cause : raw;
  const code = (error as { code?: string } | null)?.code;
  if (code && ERRORS[code]) return ERRORS[code];
  const fields = (error as { fieldErrors?: readonly { code: string; message: string }[] } | null)
    ?.fieldErrors;
  if (fields && fields.length > 0) return fields.map((f) => f.message ?? ERRORS[f.code]).join(' ');
  return detailedErrorMessage(error, fallback);
}

// --- montantes exactos -------------------------------------------------------------------------------

const SCALE = 4;
const AMOUNT = /^-?\d{1,15}(\.\d{1,4})?$/;

/** Texto → inteiro escalado (4 casas); vírgula decimal aceite; `null` se não for um montante válido. */
export function toCents(text: string): bigint | null {
  const value = text.trim().replace(',', '.');
  if (value === '') return 0n;
  if (!AMOUNT.test(value)) return null;
  const negative = value.startsWith('-');
  const [int = '0', frac = ''] = (negative ? value.slice(1) : value).split('.');
  const scaled = BigInt(int + frac.padEnd(SCALE, '0'));
  return negative ? -scaled : scaled;
}

export function fromCents(value: bigint): string {
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(SCALE + 1, '0');
  return `${negative ? '-' : ''}${digits.slice(0, -SCALE)}.${digits.slice(-SCALE)}`;
}

/** Montante normalizado para enviar ao servidor (texto, 4 casas), ou `null` se inválido. */
export const normalizeAmount = (text: string): string | null => {
  const cents = toCents(text);
  return cents === null ? null : fromCents(cents);
};

export interface LineDraft {
  accountId: string;
  debit: string;
  credit: string;
  description: string;
}

/** Totais e diferença das linhas em edição (validação em tempo real, exacta). */
export function totalsOf(lines: readonly LineDraft[]): {
  debit: string;
  credit: string;
  difference: string;
  balanced: boolean;
  invalid: number[];
} {
  let debit = 0n;
  let credit = 0n;
  const invalid: number[] = [];
  lines.forEach((l, i) => {
    const d = toCents(l.debit);
    const c = toCents(l.credit);
    if (d === null || c === null || d < 0n || c < 0n || d > 0n === c > 0n) {
      invalid.push(i);
      return;
    }
    debit += d;
    credit += c;
  });
  return {
    debit: fromCents(debit),
    credit: fromCents(credit),
    difference: fromCents(debit - credit),
    balanced: debit === credit && debit > 0n && invalid.length === 0 && lines.length >= 2,
    invalid,
  };
}

/** Montante para mostrar: separador de milhares e vírgula decimal, sem passar por `number`. */
export function formatAmount(text: string | null | undefined): string {
  if (text === null || text === undefined || text === '') return '—';
  const m = /^(-?)(\d+)(\.\d+)?$/.exec(text);
  if (!m) return text;
  return `${m[1]}${(m[2] as string).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')}${(m[3] ?? '').replace('.', ',')}`;
}

// --- plano de contas ---------------------------------------------------------------------------------

export interface TreeRow {
  readonly account: AccountDto;
  readonly depth: number;
}

/** O plano em árvore (ordem de código; profundidade pela cadeia de contas-mãe). */
export function treeOf(accounts: readonly AccountDto[]): TreeRow[] {
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const depth = (a: AccountDto): number => {
    let d = 0;
    let cursor = a.parentId ? byId.get(a.parentId) : undefined;
    while (cursor && d < 20) {
      d += 1;
      cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
    }
    return d;
  };
  return [...accounts]
    .sort((x, y) => x.code.localeCompare(y.code, 'pt', { numeric: false }))
    .map((account) => ({ account, depth: depth(account) }));
}

/** A conta-mãe mais provável para um código novo: a agregadora com o maior prefixo. */
export function suggestParent(accounts: readonly AccountDto[], code: string): AccountDto | null {
  return (
    accounts
      .filter((a) => a.kind === 'HEADER' && code.length > a.code.length && code.startsWith(a.code))
      .sort((x, y) => y.code.length - x.code.length)[0] ?? null
  );
}

export const todayIso = (): string => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** Diário proposto num lançamento manual: o geral activo; senão o primeiro activo (nunca o de abertura por ordem alfabética). */
export function defaultJournal(journals: readonly JournalDto[]): JournalDto | null {
  const active = journals.filter((j) => j.active);
  return (
    active.find((j) => j.type === 'GENERAL') ??
    active.find((j) => j.type !== 'OPENING' && j.type !== 'CLOSING') ??
    active[0] ??
    null
  );
}
