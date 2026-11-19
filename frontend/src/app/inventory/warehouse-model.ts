/** Armazéns (8.2): tipos, rótulos e árvore de localizações. */

export type LocationLevel = 'ZONE' | 'AISLE' | 'RACK' | 'BIN';

export interface WarehouseLocation {
  id: string;
  version: number;
  parentId: string | null;
  level: LocationLevel;
  code: string;
  pathCode: string;
  name: string | null;
  holdsStock: boolean;
  status: 'ACTIVE' | 'INACTIVE';
}

export interface Warehouse {
  id: string;
  version: number;
  code: string;
  name: string;
  legalEntity: { id: string; code: string; name: string };
  branch: { id: string; name: string } | null;
  manager: { membershipId: string; name: string | null } | null;
  warehouseType: string;
  addressLine: string | null;
  city: string | null;
  province: string | null;
  countryCode: string | null;
  accessMode: 'OPEN' | 'RESTRICTED';
  status: 'ACTIVE' | 'INACTIVE';
  access: { read: boolean; operate: boolean; manage: boolean } | null;
  locations?: WarehouseLocation[];
  members?:
    | { id: string; membershipId: string; name: string; email: string; level: 'VIEW' | 'OPERATE' }[]
    | null;
}

export const WAREHOUSE_TYPE: Record<string, string> = {
  MAIN: 'Central',
  STORE: 'Loja',
  TRANSIT: 'Trânsito',
  QUARANTINE: 'Quarentena',
  CONSIGNMENT: 'Consignação',
  OTHER: 'Outro',
};
export const LEVEL: Record<LocationLevel, string> = {
  ZONE: 'Zona',
  AISLE: 'Corredor',
  RACK: 'Estante',
  BIN: 'Posição',
};
export const ACCESS_LEVEL: Record<'VIEW' | 'OPERATE', string> = {
  VIEW: 'Consultar',
  OPERATE: 'Operar',
};

/** Nível do filho de uma localização (`null` = topo → zona; posição não tem filhos). */
export function childLevel(level: LocationLevel | null): LocationLevel | null {
  const order: LocationLevel[] = ['ZONE', 'AISLE', 'RACK', 'BIN'];
  if (level === null) return 'ZONE';
  return order[order.indexOf(level) + 1] ?? null;
}

/** Árvore achatada pela ordem do caminho, com a profundidade para indentar. */
export function locationRows(list: WarehouseLocation[]): (WarehouseLocation & { depth: number })[] {
  const depth: Record<LocationLevel, number> = { ZONE: 0, AISLE: 1, RACK: 2, BIN: 3 };
  return [...list]
    .sort((a, b) => (a.pathCode < b.pathCode ? -1 : a.pathCode > b.pathCode ? 1 : 0))
    .map((l) => ({ ...l, depth: depth[l.level] }));
}

/** Pré-visualização da série de códigos ("P01 … P20 (20)"). */
export function seriesPreview(
  prefix: string,
  from: number,
  to: number,
  width: number,
): string | null {
  if (!Number.isInteger(from) || !Number.isInteger(to) || to < from || to - from + 1 > 200)
    return null;
  if (!Number.isInteger(width) || width < 1 || width > 6) return null;
  const p = prefix.trim().toUpperCase();
  const code = (n: number) => `${p}${String(n).padStart(width, '0')}`;
  const n = to - from + 1;
  return n === 1 ? code(from) : `${code(from)} … ${code(to)} (${n})`;
}

export function warehouseTone(s: string): string {
  return s === 'ACTIVE' ? 'bg-success-soft text-success-text' : 'bg-surface-2 text-muted';
}
