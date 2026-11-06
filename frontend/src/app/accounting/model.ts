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

export interface PostingRuleLine {
  lineNo?: number;
  side: 'DEBIT' | 'CREDIT';
  accountId: string | null;
  accountCode?: string;
  accountName?: string;
  amountKey: string;
  description: string | null;
  costCenterId: string | null;
  useEventCostCenter: boolean;
  useEventThirdParty: boolean;
}

export interface PostingRule {
  id: string;
  version: number;
  legalEntityId: string;
  code: string;
  name: string;
  source: string;
  event: string;
  journalId: string;
  autoPost: boolean;
  descriptionTemplate: string | null;
  validFrom: string;
  validTo: string | null;
  status: string;
  inUse?: boolean;
  lines?: PostingRuleLine[];
}

export interface PostingEventView {
  id: string;
  legalEntityId: string;
  ruleId: string | null;
  ruleCode: string | null;
  source: string;
  event: string;
  sourceRef: string;
  idempotencyKey: string;
  occurredOn: string;
  status: 'POSTED' | 'DRAFTED' | 'FAILED';
  entryId: string | null;
  entryNumber: string | null;
  entryStatus: EntryStatus | null;
  error: {
    code: string;
    message: string;
    details: { path: string; code: string; message: string }[];
  } | null;
  attempts: number;
  updatedAt: string;
}

export const EVENT_STATUS: Record<PostingEventView['status'], string> = {
  POSTED: 'Contabilizado',
  DRAFTED: 'Rascunho criado',
  FAILED: 'Falhou',
};

/** Chaves de montante distintas pedidas pelas linhas de uma regra (os campos a preencher na simulação). */
export function amountKeys(lines: Pick<PostingRuleLine, 'amountKey'>[]) {
  return [...new Set(lines.map((l) => l.amountKey.trim()).filter(Boolean))];
}

/** Mensagem legível de um erro registado num evento (primeiro detalhe, se houver). */
export function eventErrorText(e: PostingEventView) {
  if (!e.error) return '';
  const first = e.error.details?.[0];
  return first ? `${e.error.message} ${first.message}` : e.error.message;
}

export interface OpeningLine {
  accountCode: string;
  debit: string | null;
  credit: string | null;
  costCenterCode: string | null;
  thirdPartyRef: string | null;
  description: string | null;
}

const HEADER_ALIASES: Record<string, keyof OpeningLine> = {
  conta: 'accountCode',
  account: 'accountCode',
  codigo: 'accountCode',
  debito: 'debit',
  devedor: 'debit',
  debit: 'debit',
  credito: 'credit',
  credor: 'credit',
  credit: 'credit',
  centro: 'costCenterCode',
  centrodecusto: 'costCenterCode',
  terceiro: 'thirdPartyRef',
  nif: 'thirdPartyRef',
  descricao: 'description',
};
const ORDER: (keyof OpeningLine)[] = [
  'accountCode',
  'debit',
  'credit',
  'costCenterCode',
  'thirdPartyRef',
  'description',
];
const plain = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z]/g, '');

/**
 * Lê saldos de abertura colados de uma folha de cálculo ou CSV: separador `;`, tab ou `,` (detectado na primeira
 * linha), cabeçalho opcional (conta, débito, crédito, centro, terceiro, descrição; por omissão esta ordem), valores com
 * vírgula decimal. Linhas vazias são ignoradas. A validação é do servidor.
 */
export function parseOpeningCsv(text: string): OpeningLine[] {
  const rows = text.split(/\r?\n/).filter((r) => r.trim() !== '');
  if (rows.length === 0) return [];
  const first = rows[0];
  const sep = first.includes(';') ? ';' : first.includes('\t') ? '\t' : ',';
  const cells = (r: string) => r.split(sep).map((c) => c.trim().replace(/^"(.*)"$/, '$1'));
  let order = ORDER;
  const head = cells(first).map(plain);
  if (head.some((h) => h in HEADER_ALIASES)) {
    order = head.map((h) => HEADER_ALIASES[h] ?? ('' as keyof OpeningLine));
    rows.shift();
  }
  return rows.map((r) => {
    const values = cells(r);
    const line: OpeningLine = {
      accountCode: '',
      debit: null,
      credit: null,
      costCenterCode: null,
      thirdPartyRef: null,
      description: null,
    };
    order.forEach((key, i) => {
      if (!key) return;
      const v = values[i] ?? '';
      if (key === 'accountCode') line.accountCode = v;
      else if (key === 'debit' || key === 'credit') line[key] = v ? normalizeAmount(v) : null;
      else line[key] = v || null;
    });
    return line;
  });
}

export interface TrialBalanceRow {
  accountId: string;
  code: string;
  name: string;
  level: string;
  depth: number;
  postable: boolean;
  opening: string;
  debit: string;
  credit: string;
  closing: string;
}

export interface TrialBalance {
  fiscalYear: { id: string; code: string; legalEntityId: string };
  fromPeriod: number;
  toPeriod: number;
  mode: 'analytic' | 'synthetic';
  balanced: boolean;
  rows: TrialBalanceRow[];
  totals: {
    opening: string;
    debit: string;
    credit: string;
    closingDebit: string;
    closingCredit: string;
  };
}

export interface LedgerLine {
  entryId: string;
  number: string;
  date: string;
  entryDescription: string;
  description: string | null;
  accountCode: string;
  thirdPartyRef: string | null;
  debit: string;
  credit: string;
  balance: string;
}

export interface Ledger {
  account: { id: string; code: string; name: string; includesSubaccounts: boolean };
  fiscalYear: { id: string; code: string };
  from: string;
  to: string;
  opening: string;
  debit: string;
  credit: string;
  closing: string;
  lines: LedgerLine[];
  truncated: boolean;
}

/** Saldo com sinal → coluna devedora/credora para apresentação. */
export function splitBalance(value: string): { debit: string; credit: string } {
  if (value.startsWith('-')) return { debit: '', credit: value.slice(1) };
  return { debit: /^0(\.0+)?$/.test(value) ? '' : value, credit: '' };
}
