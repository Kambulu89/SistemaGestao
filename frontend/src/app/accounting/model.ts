/**
 * Tipos e regras de apresentação da contabilidade. As regras que contam (partidas dobradas, períodos, segregação de
 * funções) são do servidor; aqui só se mostra o equilíbrio enquanto se escreve e que acções fazem sentido.
 */
export interface Chart {
  id: string;
  version: number;
  legalEntityId: string;
  code: string;
  name: string;
  jurisdiction: string;
  baseModel: string | null;
  status: string;
}

export interface Account {
  id: string;
  version: number;
  chartId: string;
  parentId: string | null;
  code: string;
  name: string;
  level: 'CLASS' | 'ACCOUNT' | 'SUBACCOUNT';
  nature: string;
  normalBalance: 'DEBIT' | 'CREDIT';
  postable: boolean;
  requiresCostCenter: boolean;
  requiresThirdParty: boolean;
  statementLine: string | null;
  status: string;
}

export interface Period {
  id: string;
  number: number;
  kind: 'OPENING' | 'NORMAL' | 'CLOSING';
  name: string;
  startDate: string;
  endDate: string;
  status: 'OPEN' | 'CLOSED';
}

export interface FiscalYear {
  id: string;
  version: number;
  legalEntityId: string;
  code: string;
  startDate: string;
  endDate: string;
  status: string;
  periods?: Period[];
}

export interface Journal {
  id: string;
  version: number;
  legalEntityId: string;
  code: string;
  name: string;
  type: string;
  documentSeriesId: string;
  status: string;
}

export type EntryStatus = 'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'POSTED';

export interface EntryLine {
  accountId: string;
  accountCode?: string;
  accountName?: string;
  description: string | null;
  debit: string;
  credit: string;
  debitFunctional?: string;
  creditFunctional?: string;
  costCenterId: string | null;
  thirdPartyRef: string | null;
}

export interface Entry {
  id: string;
  version: number;
  legalEntityId: string;
  fiscalYearCode: string;
  periodId: string;
  periodName: string;
  periodStatus: string;
  journalId: string;
  journalCode: string;
  journalName: string;
  number: string | null;
  entryDate: string;
  documentDate: string | null;
  reference: string | null;
  description: string;
  currency: string;
  exchangeRate: string;
  source: string;
  status: EntryStatus;
  totalDebit: string;
  totalCredit: string;
  createdBy: string | null;
  submittedBy: string | null;
  rejectionReason: string | null;
  reversalOfId: string | null;
  reversedById: string | null;
  lines: EntryLine[];
}

export const NATURES = [
  { value: 'ASSET', label: 'Activo' },
  { value: 'LIABILITY', label: 'Passivo' },
  { value: 'EQUITY', label: 'Capital próprio' },
  { value: 'REVENUE', label: 'Rendimentos' },
  { value: 'EXPENSE', label: 'Gastos' },
  { value: 'OFF_BALANCE', label: 'Extrapatrimonial' },
];
export const LEVELS = [
  { value: 'CLASS', label: 'Classe' },
  { value: 'ACCOUNT', label: 'Conta' },
  { value: 'SUBACCOUNT', label: 'Subconta' },
];
export const JOURNAL_TYPES = [
  { value: 'GENERAL', label: 'Geral' },
  { value: 'SALES', label: 'Vendas' },
  { value: 'PURCHASES', label: 'Compras' },
  { value: 'CASH', label: 'Caixa' },
  { value: 'BANK', label: 'Bancos' },
  { value: 'PAYROLL', label: 'Salários' },
  { value: 'INVENTORY', label: 'Inventário' },
  { value: 'OPENING', label: 'Abertura' },
  { value: 'ADJUSTMENT', label: 'Regularizações' },
];
export const ENTRY_STATUS: Record<EntryStatus, string> = {
  DRAFT: 'Rascunho',
  SUBMITTED: 'Submetido',
  APPROVED: 'Aprovado',
  POSTED: 'Contabilizado',
};
export const label = (list: { value: string; label: string }[], value: string) =>
  list.find((x) => x.value === value)?.label ?? value;

const DECIMAL = /^\d+(?:\.\d+)?$/;

/**
 * Valor escrito pelo utilizador → texto decimal com ponto (`1 500,25` → `1500.25`). Aceita vírgula decimal e espaços
 * ou pontos como separadores de milhares quando há vírgula. Devolve o texto aparado se não o souber interpretar (o
 * servidor recusa-o com uma mensagem).
 */
export function normalizeAmount(raw: string | null | undefined): string {
  let text = (raw ?? '').trim().replace(/\s/g, '');
  if (text.includes(',')) text = text.replace(/\./g, '').replace(',', '.');
  return text;
}

/** Texto decimal → inteiro escalado (null se vazio/ inválido). Sem `float`. */
export function toScaled(value: string | null | undefined, scale: number): bigint | null {
  const text = (value ?? '').trim();
  if (!DECIMAL.test(text)) return null;
  const [int, frac = ''] = text.split('.');
  if (frac.length > scale && /[1-9]/.test(frac.slice(scale))) return null;
  return BigInt(int + frac.slice(0, scale).padEnd(scale, '0'));
}

export function fromScaled(value: bigint, scale: number): string {
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(scale + 1, '0');
  const int = digits.slice(0, digits.length - scale);
  return `${negative ? '-' : ''}${int}${scale > 0 ? '.' + digits.slice(digits.length - scale) : ''}`;
}

/** Totais das linhas enquanto se escreve: débito, crédito, diferença e se há linhas com valor inválido. */
export function lineTotals(lines: { debit: string; credit: string }[], scale: number) {
  let debit = 0n;
  let credit = 0n;
  let invalid = false;
  for (const l of lines) {
    for (const [side, raw] of [
      ['d', l.debit],
      ['c', l.credit],
    ] as const) {
      if (!raw || raw.trim() === '') continue;
      const v = toScaled(normalizeAmount(raw), scale);
      if (v === null) invalid = true;
      else if (side === 'd') debit += v;
      else credit += v;
    }
  }
  return {
    debit: fromScaled(debit, scale),
    credit: fromScaled(credit, scale),
    difference: fromScaled(debit - credit, scale),
    balanced: debit === credit && debit > 0n && !invalid,
    invalid,
  };
}

/** Contas ordenadas em árvore (pai antes dos filhos, por código) com a profundidade. */
export function accountTree(accounts: Account[]) {
  const byParent = new Map<string | null, Account[]>();
  const ids = new Set(accounts.map((a) => a.id));
  for (const a of accounts) {
    const parent = a.parentId && ids.has(a.parentId) ? a.parentId : null;
    byParent.set(parent, [...(byParent.get(parent) ?? []), a]);
  }
  const out: { account: Account; depth: number }[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const a of (byParent.get(parent) ?? []).sort((x, y) => x.code.localeCompare(y.code))) {
      out.push({ account: a, depth });
      walk(a.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

export interface Actor {
  userId: string | null;
  can: (permission: string) => boolean;
}

/**
 * Acções que o actor pode tentar sobre um lançamento (o servidor decide; aqui só não se mostram botões impossíveis).
 * Quem criou ou submeteu não aprova nem rejeita.
 */
export function entryActions(
  entry: Pick<Entry, 'status' | 'createdBy' | 'submittedBy' | 'reversalOfId' | 'reversedById'>,
  actor: Actor,
) {
  const own =
    actor.userId !== null &&
    (entry.createdBy === actor.userId || entry.submittedBy === actor.userId);
  return {
    edit: entry.status === 'DRAFT' && actor.can('accounting.create'),
    remove: entry.status === 'DRAFT' && actor.can('accounting.create'),
    submit: entry.status === 'DRAFT' && actor.can('accounting.create'),
    approve: entry.status === 'SUBMITTED' && actor.can('accounting.approve') && !own,
    reject:
      (entry.status === 'SUBMITTED' || entry.status === 'APPROVED') &&
      actor.can('accounting.approve') &&
      !own,
    post: entry.status === 'APPROVED' && actor.can('accounting.post'),
    reverse:
      entry.status === 'POSTED' &&
      !entry.reversedById &&
      !entry.reversalOfId &&
      actor.can('accounting.reverse'),
  };
}
