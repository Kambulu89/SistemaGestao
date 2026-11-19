/** Regras puras dos armazéns (8.2): hierarquia de localizações, códigos de caminho, geração em série e acesso. */

export const WAREHOUSE_TYPES = [
  'MAIN',
  'STORE',
  'TRANSIT',
  'QUARANTINE',
  'CONSIGNMENT',
  'OTHER',
] as const
export const LOCATION_LEVELS = ['ZONE', 'AISLE', 'RACK', 'BIN'] as const
export type LocationLevel = (typeof LOCATION_LEVELS)[number]
export const ACCESS_LEVELS = ['VIEW', 'OPERATE'] as const
export type AccessLevel = (typeof ACCESS_LEVELS)[number]

const LOCATION_CODE = /^[A-Z0-9][A-Z0-9_]{0,19}$/
export const isLocationCode = (v: unknown): v is string =>
  typeof v === 'string' && LOCATION_CODE.test(v)

/** Nível que vem a seguir (zona → corredor → estante → posição); `null` depois da posição. */
export function childLevel(level: LocationLevel | null): LocationLevel | null {
  if (level === null) return 'ZONE'
  const i = LOCATION_LEVELS.indexOf(level)
  return LOCATION_LEVELS[i + 1] ?? null
}

/** Código completo: o do superior seguido do próprio ("A-01-03-B"). */
export function pathCode(parentPath: string | null, code: string) {
  return parentPath ? `${parentPath}-${code}` : code
}

/**
 * Códigos em série para gerar posições (ex.: prefixo "P", 1 a 20, 2 dígitos → P01…P20). No máximo 200 de cada vez.
 * Devolve `null` se o intervalo ou o formato forem inválidos.
 */
export function seriesCodes(
  prefix: string,
  from: number,
  to: number,
  width: number
): string[] | null {
  if (!Number.isInteger(from) || !Number.isInteger(to) || !Number.isInteger(width)) return null
  if (from < 0 || to < from || to - from + 1 > 200 || width < 1 || width > 6) return null
  const p = prefix.trim().toUpperCase()
  const out: string[] = []
  for (let n = from; n <= to; n++) {
    const code = `${p}${String(n).padStart(width, '0')}`
    if (!isLocationCode(code)) return null
    out.push(code)
  }
  return out
}

export interface AccessFacts {
  /** O âmbito de `inventory.warehouses.manage` cobre o armazém. */
  manage: boolean
  /** O âmbito de `inventory.read` cobre o armazém. */
  read: boolean
  mode: 'OPEN' | 'RESTRICTED'
  /** Entrada do membro na lista do armazém (restrito). */
  entry: AccessLevel | null
}

/**
 * Acesso ao armazém: quem o gere vê e opera; os restantes precisam de `inventory.read` no âmbito e, num armazém restrito,
 * de estar na lista (consultar ou operar). Operar ainda exigirá a permissão da operação nos blocos de stock.
 */
export function warehouseAccess(f: AccessFacts) {
  if (f.manage) return { read: true, operate: true, manage: true }
  if (!f.read) return null
  if (f.mode === 'OPEN') return { read: true, operate: true, manage: false }
  if (!f.entry) return null
  return { read: true, operate: f.entry === 'OPERATE', manage: false }
}
