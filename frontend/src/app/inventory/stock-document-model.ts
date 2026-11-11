/** Entradas e saídas de stock (8.4): tipos, estados, linhas e regras da interface. */

export type DocType = 'RECEIPT' | 'ISSUE';
export type DocStatus = 'DRAFT' | 'CHECKED' | 'PARTIAL' | 'COMPLETED' | 'CANCELLED';

export interface DocLine {
  id: string;
  lineNo: number;
  product: { id: string; sku: string; name: string };
  variant: { id: string; sku: string } | null;
  uom: { id: string; code: string };
  baseUom: string;
  factor: string;
  quantity: string;
  baseQuantity: string;
  location: { id: string; pathCode: string } | null;
  bucket: string;
  lotCode: string | null;
  serials: string[];
  expiryDate: string | null;
  unitCost: string | null;
  trackSerials: boolean;
  checkedQuantity: string | null;
  differenceReason: string | null;
  confirmedQuantity: string;
  remainingQuantity: string;
}

export interface DocConfirmation {
  id: string;
  seq: number;
  postingId: string;
  reversalPostingId: string | null;
  createdAt: string;
  createdBy: string | null;
  reversedAt: string | null;
  reversedBy: string | null;
  reverseReason: string | null;
  lines: { lineId: string; quantity: string; baseQuantity: string }[];
}

export interface StockDocument {
  id: string;
  version: number;
  docType: DocType;
  number: string | null;
  status: DocStatus;
  documentDate: string;
  warehouse: { id: string; code: string; name?: string };
  legalEntity?: { id: string; code: string };
  origin: string;
  originRef: string | null;
  counterparty: string | null;
  notes?: string | null;
  currency?: string | null;
  /** Devolução (8.9): documento original, cujo custo a devolução usa. */
  returnOf?: { id: string; number: string | null } | null;
  checkedBy?: string | null;
  checkedAt?: string | null;
  closedShort: boolean;
  closeReason?: string | null;
  cancelReason?: string | null;
  createdBy?: string | null;
  can?: { manage: boolean; confirm: boolean };
  lineCount?: number;
  lines?: DocLine[];
  confirmations?: DocConfirmation[];
}

export const DOC_TYPE: Record<DocType, string> = { RECEIPT: 'Entrada', ISSUE: 'Saída' };
export const DOC_STATUS: Record<DocStatus, string> = {
  DRAFT: 'Rascunho',
  CHECKED: 'Conferido',
  PARTIAL: 'Parcial',
  COMPLETED: 'Concluído',
  CANCELLED: 'Anulado',
};
export const ORIGIN: Record<string, string> = {
  PURCHASE: 'Compra',
  RETURN: 'Devolução',
  PRODUCTION: 'Produção',
  OPENING: 'Saldo inicial',
  CONSUMPTION: 'Consumo interno',
  SALE: 'Venda',
  LOSS: 'Perda / quebra',
  SAMPLE: 'Amostra',
  OTHER: 'Outra',
};
export const ORIGINS: Record<DocType, string[]> = {
  RECEIPT: ['PURCHASE', 'RETURN', 'PRODUCTION', 'OPENING', 'OTHER'],
  ISSUE: ['CONSUMPTION', 'SALE', 'LOSS', 'RETURN', 'SAMPLE', 'OTHER'],
};
export const LINE_BUCKET: Record<string, string> = {
  UNRESTRICTED: 'Livre',
  QUARANTINE: 'Quarentena',
  BLOCKED: 'Bloqueado',
};

export function statusTone(s: DocStatus): string {
  switch (s) {
    case 'COMPLETED':
      return 'bg-success-soft text-success-text';
    case 'PARTIAL':
    case 'CHECKED':
      return 'bg-info-soft text-info-text';
    case 'CANCELLED':
      return 'bg-danger-soft text-danger-text';
    default:
      return 'bg-surface-2 text-muted';
  }
}

/** Acções disponíveis por estado e direitos (a API decide; isto é só a interface). */
export function docActions(d: Pick<StockDocument, 'status' | 'can' | 'confirmations'>) {
  const manage = !!d.can?.manage;
  const confirm = !!d.can?.confirm;
  const hasConf = (d.confirmations ?? []).length > 0;
  return {
    edit: manage && d.status === 'DRAFT',
    check: manage && (d.status === 'DRAFT' || d.status === 'PARTIAL'),
    reopen: manage && d.status === 'CHECKED',
    confirm: confirm && d.status === 'CHECKED',
    close: confirm && d.status === 'PARTIAL',
    cancel: manage && (d.status === 'DRAFT' || d.status === 'CHECKED') && !hasConf,
    reverse: confirm && d.status !== 'CANCELLED',
  };
}

/** Escala texto decimal (até 6 casas, vírgula ou ponto) para inteiro ×10⁶; `null` se inválido. */
export function toMicros(raw: string | null | undefined): bigint | null {
  const t = (raw ?? '').trim().replace(',', '.');
  if (!/^\d{1,12}(\.\d{1,6})?$/.test(t)) return null;
  const [i, f = ''] = t.split('.');
  return BigInt(i) * 1_000_000n + BigInt((f + '000000').slice(0, 6));
}

const fromMicros = (v: bigint) => {
  const i = v / 1_000_000n;
  const f = (v % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return f ? `${i},${f}` : `${i}`;
};

/** Pré-visualização da quantidade base (mesmo arredondamento do servidor: 6 casas, meio para cima). */
export function basePreview(quantity: string, factor: string): string | null {
  const q = toMicros(quantity);
  const f = toMicros(factor);
  if (q === null || f === null || q === 0n) return null;
  const unit = 1_000_000n;
  return fromMicros((q * f * 2n + unit) / (2n * unit));
}

/** Números de série escritos um por linha ou separados por vírgulas. */
export const parseSerials = (raw: string) =>
  raw
    .split(/[\n,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);

/** Quantidades por defeito da conferência: o que falta confirmar em cada linha. */
export const checkDefaults = (lines: DocLine[]) =>
  Object.fromEntries(lines.map((l) => [l.id, l.remainingQuantity.replace(/\.?0+$/, '') || '0']));
