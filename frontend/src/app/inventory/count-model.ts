/** Contagens físicas e ajustes (8.7): estados, motivos, acções por estado e direitos, e o que mudou na contagem. */

export type CountStatus = 'DRAFT' | 'COUNTING' | 'REVIEW' | 'APPROVED' | 'CANCELLED';

export interface CountLine {
  id: string;
  lineNo: number;
  location: { id: string; pathCode: string } | null;
  product: { id: string; sku: string; name: string };
  variant: { id: string; sku: string } | null;
  uom: string;
  decimals: number;
  countedQuantity: string | null;
  round: number;
  recountRequested: boolean;
  recountReason: string | null;
  addedDuringCount: boolean;
  lot?: { id: string; code: string; expiryDate: string | null } | null;
  tracksLots?: boolean;
  tracksSerials?: boolean;
  entries: number;
  /** Quantidades do sistema: `null` numa contagem cega para quem só conta. */
  snapshotQuantity: string | null;
  difference: string | null;
  movedSinceSnapshot: string | null;
  reasonCode: string | null;
  justification: string | null;
}

export interface StockCount {
  id: string;
  version?: number;
  number: string | null;
  status: CountStatus;
  description: string;
  blind: boolean;
  warehouse: { id: string; code: string; name?: string };
  legalEntity?: { id: string; code: string };
  location?: { id: string; pathCode: string } | null;
  zone?: string | null;
  category?: { id: string; code: string; name: string } | null;
  plannedDate: string | null;
  notes?: string | null;
  started?: { by: string; at: string } | null;
  submitted?: { by: string; at: string } | null;
  approved?: { by: string; at: string } | null;
  cancelReason?: string | null;
  lineCount?: number;
  countedCount?: number;
  can?: { manage: boolean; approve: boolean; review: boolean; seeBook: boolean; counted: boolean };
  summary?: { lines: number; counted: number; withDifference: number | null };
  postings?: { seq: number; postingId: string }[];
  lines?: CountLine[];
}

export const COUNT_STATUS: Record<CountStatus, string> = {
  DRAFT: 'Plano',
  COUNTING: 'Em contagem',
  REVIEW: 'Em revisão',
  APPROVED: 'Ajustada',
  CANCELLED: 'Anulada',
};

export const COUNT_REASON: Record<string, string> = {
  COUNT_ERROR: 'Erro de contagem anterior',
  UNRECORDED_RECEIPT: 'Entrada não registada',
  UNRECORDED_ISSUE: 'Saída não registada',
  DAMAGE: 'Dano / quebra',
  EXPIRY: 'Fora de validade',
  THEFT_LOSS: 'Furto / extravio',
  LOCATION_MIX: 'Troca de localização',
  OTHER: 'Outro',
};

export function countTone(s: CountStatus): string {
  if (s === 'APPROVED') return 'bg-success-soft text-success-text';
  if (s === 'CANCELLED') return 'bg-danger-soft text-danger-text';
  if (s === 'DRAFT') return 'bg-surface-2 text-muted';
  return 'bg-info-soft text-info-text';
}

/** Acções visíveis (a API decide). Quem contou não aprova; numa contagem cega só quem aprova justifica. */
export function countActions(c: Pick<StockCount, 'status' | 'can' | 'blind'>) {
  const k = c.can ?? {
    manage: false,
    approve: false,
    review: false,
    seeBook: false,
    counted: false,
  };
  const s = c.status;
  return {
    edit: k.manage && s === 'DRAFT',
    start: k.manage && s === 'DRAFT',
    count: k.manage && s === 'COUNTING',
    addLine: k.manage && s === 'COUNTING',
    submit: k.manage && s === 'COUNTING',
    justify: s === 'REVIEW' && (k.review || (k.manage && !c.blind)),
    recount: k.review && s === 'REVIEW',
    approve: k.approve && s === 'REVIEW',
    cancel: (k.manage || k.review) && ['DRAFT', 'COUNTING', 'REVIEW'].includes(s),
  };
}

const norm = (v: string) => v.replace(/\s/g, '').replace(',', '.');
const same = (a: string, b: string | null) => b !== null && Number(norm(a)) === Number(b);

/** Quantidades escritas que mudam o que está registado (vazias e iguais não se enviam). */
export function countedChanges(lines: CountLine[], typed: Record<string, string>) {
  return lines
    .filter((l) => {
      const v = typed[l.id];
      return v !== undefined && norm(v) !== '' && !same(v, l.countedQuantity);
    })
    .map((l) => ({ lineId: l.id, quantity: norm(typed[l.id]) }));
}

/** Linhas com diferença (para justificar): só quando o sistema é visível. */
export const linesWithDifference = (lines: CountLine[]) =>
  lines.filter((l) => l.difference !== null && Number(l.difference) !== 0);
