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

export interface DimensionValue {
  id: string;
  version: number;
  dimensionId: string;
  code: string;
  name: string;
  status: string;
}

export interface Dimension {
  id: string;
  version: number;
  code: string;
  name: string;
  status: string;
  values: DimensionValue[];
}

/** Destino de uma repartição (linha de chave ou imputação de linha): percentagem, centro de custo e valores. */
export interface AllocationTarget {
  lineNo?: number;
  percent: string;
  costCenterId: string | null;
  values: { dimensionId: string; valueId: string; valueCode?: string; valueName?: string }[];
}

export interface AllocationKey {
  id: string;
  version: number;
  legalEntityId: string;
  code: string;
  name: string;
  status: string;
  lines?: AllocationTarget[];
}

export interface AnalyticReport {
  groupBy: 'costCenter' | 'dimension';
  rows: { key: string | null; label: string; debit: string; credit: string; net: string }[];
  totals: { debit: string; credit: string; net: string };
  ledger: { debit: string; credit: string };
  consistent: boolean;
}

/** Soma das percentagens (4 casas, sem `float`) e se é exactamente 100. */
export function percentTotal(targets: Pick<AllocationTarget, 'percent'>[]) {
  let total = 0n;
  let invalid = false;
  for (const t of targets) {
    const v = toScaled(normalizeAmount(t.percent), 4);
    if (v === null || v <= 0n) invalid = true;
    else total += v;
  }
  return {
    total: fromScaled(total, 4).replace(/\.?0+$/, '') || '0',
    complete: !invalid && total === 1000000n,
    invalid,
  };
}

/** Percentagens iguais para `n` destinos que somam exactamente 100 (o resto de 0,0001 vai para o último). */
export function evenPercents(n: number): string[] {
  if (n <= 0) return [];
  const each = 1000000n / BigInt(n);
  const last = 1000000n - each * BigInt(n - 1);
  return Array.from({ length: n }, (_, i) =>
    fromScaled(i === n - 1 ? last : each, 4).replace(/\.?0+$/, ''),
  );
}

// ---------------------------------------------------------------- activos fixos (6.6)

export type DepreciationMethod = 'STRAIGHT_LINE' | 'DECLINING_BALANCE';
export const METHOD_LABELS: Record<DepreciationMethod, string> = {
  STRAIGHT_LINE: 'Linha recta',
  DECLINING_BALANCE: 'Degressivo',
};

export interface AssetClass {
  id: string;
  version: number;
  legalEntityId: string;
  code: string;
  name: string;
  method: DepreciationMethod;
  usefulLifeMonths: number;
  decliningFactor: string | null;
  journalId: string;
  assetAccountId: string;
  accumulatedAccountId: string;
  expenseAccountId: string;
  gainAccountId: string;
  lossAccountId: string;
  status: string;
}

export type AssetStatus = 'DRAFT' | 'ACTIVE' | 'DISPOSED';
export const ASSET_STATUS: Record<AssetStatus, string> = {
  DRAFT: 'Por contabilizar',
  ACTIVE: 'Em uso',
  DISPOSED: 'Abatido',
};

export interface ScheduleLine {
  month: string;
  amount: string;
  accumulated: string;
  bookValue: string;
  posted: boolean;
  entryId: string | null;
  entryNumber: string | null;
}

export interface AssetMovement {
  id: string;
  type: string;
  date: string;
  fromLocation: string | null;
  toLocation: string | null;
  fromCostCenterId: string | null;
  toCostCenterId: string | null;
  entryId: string | null;
  entryNumber: string | null;
  notes: string | null;
}

export const MOVEMENT_LABELS: Record<string, string> = {
  ACQUISITION: 'Aquisição',
  TRANSFER: 'Transferência',
  DISPOSAL: 'Abate',
  ACQUISITION_REVERSED: 'Aquisição anulada',
  DISPOSAL_REVERSED: 'Abate anulado',
};

export interface FixedAsset {
  id: string;
  version: number;
  legalEntityId: string;
  classId: string;
  number: string;
  name: string;
  description: string | null;
  serialNumber: string | null;
  supplierName: string | null;
  acquisitionDocument: string | null;
  acquisitionDate: string;
  cost: string;
  residualValue: string;
  usefulLifeMonths: number;
  method: DepreciationMethod;
  decliningFactor: string | null;
  depreciationStart: string;
  location: string | null;
  costCenterId: string | null;
  status: AssetStatus;
  acquisitionEntryId: string | null;
  disposalDate: string | null;
  disposalProceeds: string | null;
  disposalReason: string | null;
  disposalEntryId: string | null;
  accumulated: string;
  bookValue: string;
  class?: { id: string; code: string; name: string } | null;
  acquisitionEntryNumber?: string | null;
  disposalEntryNumber?: string | null;
  schedule?: ScheduleLine[];
  movements?: AssetMovement[];
}

export interface DepreciationPreview {
  rows: {
    assetId: string;
    number: string;
    name: string;
    month: string;
    amount: string;
    costCenterId: string | null;
  }[];
  months: { month: string; assets: number; total: string }[];
  total: string;
  entries?: { id: string; number: string; month: string; total: string; assets: number }[];
}

export interface DepreciationMapRow {
  assetId: string;
  number: string;
  name: string;
  classCode: string;
  status: AssetStatus;
  acquisitionDate: string;
  disposalDate: string | null;
  cost: string;
  opening: string;
  period: string;
  closing: string;
  bookValue: string;
  forecast: string;
}

export interface DepreciationMap {
  fiscalYear: string;
  from: string;
  to: string;
  rows: DepreciationMapRow[];
  classes: ({ classId: string; code: string; name: string } & Record<string, string>)[];
  totals: Record<string, string>;
}

/**
 * Acções disponíveis na ficha, conforme o estado e as permissões (a API volta a verificar tudo). Anular a aquisição
 * só faz sentido sem depreciações; anular o abate, só com o activo abatido.
 */
export function assetActions(
  a: Pick<FixedAsset, 'status' | 'schedule'>,
  can: (permission: string) => boolean,
) {
  const manage = can('fixed_assets.manage');
  const post = can('fixed_assets.post');
  const depreciated = (a.schedule ?? []).some((s) => s.posted);
  return {
    edit: manage && a.status !== 'DISPOSED',
    remove: manage && a.status === 'DRAFT',
    acquire: post && a.status === 'DRAFT',
    transfer: manage && a.status === 'ACTIVE',
    dispose: post && a.status === 'ACTIVE',
    reverseAcquisition: post && a.status === 'ACTIVE' && !depreciated,
    reverseDisposal: post && a.status === 'DISPOSED',
  };
}

/** Mês corrente (AAAA-MM) no fuso local, para pré-preencher a depreciação. */
export function currentMonth(now = new Date()) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

/** Vida útil legível: "5 anos", "18 meses", "2 anos e 6 meses". */
export function lifeText(months: number) {
  const y = Math.floor(months / 12);
  const m = months % 12;
  const parts = [
    y ? `${y} ano${y > 1 ? 's' : ''}` : '',
    m ? `${m} ${m > 1 ? 'meses' : 'mês'}` : '',
  ];
  return parts.filter(Boolean).join(' e ') || '—';
}

// ---------------------------------------------------------------- regularizações (6.7)

export type ScheduleKind = 'RECURRING' | 'ACCRUAL' | 'DEFERRAL';
export const SCHEDULE_KIND_LABELS: Record<ScheduleKind, string> = {
  RECURRING: 'Recorrência',
  ACCRUAL: 'Acréscimo',
  DEFERRAL: 'Diferimento',
};
export const FREQUENCY_LABELS: Record<string, string> = {
  MONTHLY: 'Mensal',
  QUARTERLY: 'Trimestral',
  ANNUAL: 'Anual',
};

export interface ScheduleLineInput {
  accountId: string | null;
  debit: string | null;
  credit: string | null;
  costCenterId: string | null;
  thirdPartyRef: string | null;
  description: string | null;
}

export interface AdjustmentSchedule {
  id: string;
  version: number;
  legalEntityId: string;
  code: string;
  name: string;
  kind: ScheduleKind;
  frequency: string;
  journalId: string;
  startMonth: string;
  endMonth: string | null;
  months: number | null;
  totalAmount: string | null;
  debitAccountId: string | null;
  creditAccountId: string | null;
  costCenterId: string | null;
  description: string | null;
  status: string;
  lastMonth?: string | null;
  lines?: ScheduleLineInput[];
  occurrences?: {
    month: string;
    amount: string;
    entryId: string;
    entryNumber: string | null;
    entryStatus: string | null;
  }[];
}

export interface AdjustmentPreview {
  rows: {
    scheduleId: string;
    code: string;
    name: string;
    kind: ScheduleKind;
    month: string;
    total: string;
  }[];
  total: string;
  entries?: { entryId: string; scheduleCode: string; month: string; total: string }[];
}

export type ProvisionMovementType = 'CONSTITUTION' | 'REVERSAL' | 'USE';
export const PROVISION_MOVEMENT_LABELS: Record<ProvisionMovementType, string> = {
  CONSTITUTION: 'Constituição / reforço',
  REVERSAL: 'Reversão',
  USE: 'Utilização',
};

export interface Provision {
  id: string;
  version: number;
  legalEntityId: string;
  code: string;
  name: string;
  description: string | null;
  journalId: string;
  expenseAccountId: string;
  provisionAccountId: string;
  reversalAccountId: string;
  costCenterId: string | null;
  status: string;
  balance: string;
  postedBalance: string;
  movements?: {
    id: string;
    type: ProvisionMovementType;
    date: string;
    amount: string;
    reason: string;
    entryId: string;
    entryNumber: string | null;
    entryStatus: string | null;
    reversed: boolean;
  }[];
}

export interface FxLine {
  kind: 'UNREALIZED' | 'REALIZED';
  accountId: string;
  accountCode: string | null;
  accountName: string | null;
  currency: string;
  thirdPartyRef: string | null;
  foreignBalance: string;
  functionalBefore: string;
  rate: string | null;
  functionalAfter: string;
  difference: string;
}

export interface FxPreview {
  functionalCurrency: string;
  missingRates: string[];
  lines: FxLine[];
  gains: string;
  losses: string;
  pendingRevaluation?: string | null;
  entryId?: string;
}

export interface FxRevaluation {
  id: string;
  date: string;
  entryId: string;
  entryNumber: string | null;
  entryStatus: string | null;
  reversed: boolean;
  lines: number;
  gains: string;
  losses: string;
}

export interface OpenItem {
  entryId: string;
  lineNo: number;
  date: string;
  number: string | null;
  description: string;
  thirdPartyRef: string | null;
  debit: string;
  credit: string;
}

export interface ReconciliationGroup {
  id: string;
  thirdPartyRef: string | null;
  total: string;
  note: string | null;
  createdAt: string;
  lines: { entryId: string; lineNo: number; number: string | null; date: string }[];
}

export const itemKey = (i: Pick<OpenItem, 'entryId' | 'lineNo'>) => `${i.entryId}#${i.lineNo}`;

/**
 * Totais da selecção de linhas a reconciliar (decimais exactos): só se pode reconciliar com 2+ linhas, todas do
 * mesmo terceiro e com débitos iguais aos créditos.
 */
export function selectionTotals(items: OpenItem[], selected: ReadonlySet<string>, scale: number) {
  const chosen = items.filter((i) => selected.has(itemKey(i)));
  let debit = 0n;
  let credit = 0n;
  for (const i of chosen) {
    debit += toScaled(i.debit, scale) ?? 0n;
    credit += toScaled(i.credit, scale) ?? 0n;
  }
  const thirds = new Set(chosen.map((i) => i.thirdPartyRef ?? ''));
  return {
    count: chosen.length,
    debit: fromScaled(debit, scale),
    credit: fromScaled(credit, scale),
    difference: fromScaled(debit - credit, scale),
    sameThirdParty: thirds.size <= 1,
    ready: chosen.length >= 2 && debit === credit && thirds.size <= 1,
  };
}

// ---------------------------------------------------------------- demonstrações (6.8)

export type StatementKind = 'BALANCE_SHEET' | 'INCOME_STATEMENT';
export const STATEMENT_KIND_LABELS: Record<StatementKind, string> = {
  BALANCE_SHEET: 'Balanço',
  INCOME_STATEMENT: 'Demonstração de resultados',
};
export type StatementLineKind = 'HEADER' | 'ACCOUNTS' | 'TOTAL' | 'NET_INCOME';
export const STATEMENT_LINE_LABELS: Record<StatementLineKind, string> = {
  HEADER: 'Título',
  ACCOUNTS: 'Contas',
  TOTAL: 'Total',
  NET_INCOME: 'Resultado líquido',
};
export const TEMPLATE_STATUS: Record<string, string> = {
  DRAFT: 'Rascunho',
  PUBLISHED: 'Publicado',
  RETIRED: 'Retirado',
};

export interface StatementMapping {
  prefix: string;
  rule: 'ANY' | 'DEBIT' | 'CREDIT';
}

export interface StatementTemplateLine {
  lineNo?: number;
  code: string | null;
  label: string;
  kind: StatementLineKind;
  sign: 1 | -1;
  formula: string | null;
  noteRef: string | null;
}

export interface StatementTemplate {
  id: string;
  version: number;
  chartId: string;
  code: string;
  name: string;
  kind: StatementKind;
  status: 'DRAFT' | 'PUBLISHED' | 'RETIRED';
  checkA: string | null;
  checkB: string | null;
  publishedAt: string | null;
  lines?: StatementTemplateLine[];
  mappings?: (StatementMapping & { lineCode: string })[];
}

export interface StatementResult {
  template: {
    id: string;
    code: string;
    name: string;
    kind: StatementKind;
    version: number;
    status: string;
  };
  fiscalYear: { id: string; code: string; toPeriod: number };
  compareFiscalYear: { id: string; code: string } | null;
  lines: {
    lineNo: number;
    code: string | null;
    label: string;
    kind: StatementLineKind;
    noteRef: string | null;
    value: string | null;
    previous: string | null;
    accounts: { code: string; name: string; amount: string }[];
  }[];
  unmapped: { code: string; name: string; balance: string }[];
  previousUnmapped: number;
  netIncome: string;
  check: { a: string; b: string; ok: boolean } | null;
  consistent: boolean;
  notes: StatementNote[];
}

export interface StatementNote {
  id: string;
  version?: number;
  number: number;
  title: string;
  body: string;
}

const RULE_SUFFIX: Record<StatementMapping['rule'], string> = {
  ANY: '',
  DEBIT: ':D',
  CREDIT: ':C',
};

/** "111, 113:D, 113:C" ↔ prefixos com regra de saldo (D = devedor, C = credor). */
export function formatMappings(mappings: StatementMapping[]) {
  return mappings.map((m) => m.prefix + RULE_SUFFIX[m.rule]).join(', ');
}

export function parseMappings(text: string): StatementMapping[] | null {
  const parts = text
    .split(/[,;\s]+/)
    .map((p) => p.trim())
    .filter(Boolean);
  const out: StatementMapping[] = [];
  for (const p of parts) {
    const m = /^([0-9A-Za-z.]{1,30})(?::([DC]))?$/i.exec(p);
    if (!m) return null;
    out.push({
      prefix: m[1],
      rule: !m[2] ? 'ANY' : m[2].toUpperCase() === 'D' ? 'DEBIT' : 'CREDIT',
    });
  }
  return out;
}
