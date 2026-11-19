/**
 * Relatórios de RH (7.12): contas puras sobre factos já gravados (admissões, cessações aprovadas, colocações com
 * vigência). Taxas em inteiros (centésimas de ponto percentual, meio para cima), nunca `float`.
 */

export interface Placement {
  validFrom: string
  validTo: string | null
  legalEntityId: string
  departmentId: string | null
  positionId: string | null
}

export interface StaffFact {
  id: string
  hireDate: string
  /** Último dia de trabalho de uma cessação aprovada ou concluída; `null` se em funções. */
  exitDate: string | null
  exitReason: string | null
  exitInitiative: string | null
  /** Colocação actual (fallback quando não há histórico de colocações). */
  current: Omit<Placement, 'validFrom' | 'validTo'>
  placements: Placement[]
  contractTypes: { start: string; end: string | null; type: string }[]
}

/** Em funções na data (inclusive o último dia). */
export function activeAt(f: StaffFact, date: string) {
  return f.hireDate <= date && (f.exitDate === null || f.exitDate >= date)
}

/** Colocação em vigor na data (a mais recente que a cobre); sem histórico, a actual. */
export function placementAt(f: StaffFact, date: string) {
  const p = f.placements
    .filter((x) => x.validFrom <= date && (x.validTo === null || x.validTo >= date))
    .sort((a, b) => (a.validFrom < b.validFrom ? 1 : -1))[0]
  return p ?? f.current
}

export function contractTypeAt(f: StaffFact, date: string) {
  return (
    f.contractTypes
      .filter((c) => c.start <= date && (c.end === null || c.end >= date))
      .sort((a, b) => (a.start < b.start ? 1 : -1))[0]?.type ?? null
  )
}

const monthEnd = (year: number, month: number) =>
  new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10)
const pad = (n: number) => String(n).padStart(2, '0')

/** Percentagem com 2 casas de `num / den × 100`, meio para cima; `null` se `den` = 0. */
export function percent(num: bigint, den: bigint): string | null {
  if (den <= 0n) return null
  const hundredths = (num * 10_000n * 2n + den) / (2n * den)
  const s = hundredths.toString().padStart(3, '0')
  return `${s.slice(0, -2)}.${s.slice(-2)}`
}

function countBy<T>(items: T[], key: (t: T) => string | null) {
  const m = new Map<string, number>()
  for (const i of items) {
    const k = key(i) ?? ''
    m.set(k, (m.get(k) ?? 0) + 1)
  }
  return [...m.entries()]
    .map(([k, n]) => ({ key: k || null, count: n }))
    .sort((a, b) => b.count - a.count)
}

/** Efectivos numa data, por entidade legal, departamento, cargo e tipo de contrato. */
export function headcount(facts: StaffFact[], date: string) {
  const active = facts.filter((f) => activeAt(f, date))
  const placed = active.map((f) => ({ f, p: placementAt(f, date) }))
  return {
    date,
    total: active.length,
    byLegalEntity: countBy(placed, (x) => x.p.legalEntityId),
    byDepartment: countBy(placed, (x) => x.p.departmentId),
    byPosition: countBy(placed, (x) => x.p.positionId),
    byContractType: countBy(active, (f) => contractTypeAt(f, date)),
  }
}

/**
 * Rotatividade do ano: por mês, efectivos no primeiro e no último dia, admissões, saídas e taxa (saídas / média dos
 * efectivos). A taxa anual usa a média das médias mensais. Saídas por motivo e por iniciativa.
 */
export function turnover(facts: StaffFact[], year: number) {
  const months = []
  let exitsYear = 0
  let sumStartEnd = 0n
  for (let m = 1; m <= 12; m++) {
    const first = `${year}-${pad(m)}-01`
    const last = monthEnd(year, m)
    const start = facts.filter((f) => activeAt(f, first)).length
    const end = facts.filter((f) => activeAt(f, last)).length
    const hires = facts.filter((f) => f.hireDate >= first && f.hireDate <= last).length
    const exits = facts.filter(
      (f) => f.exitDate && f.exitDate >= first && f.exitDate <= last
    ).length
    exitsYear += exits
    sumStartEnd += BigInt(start + end)
    months.push({
      month: `${year}-${pad(m)}`,
      start,
      end,
      hires,
      exits,
      rate: percent(BigInt(exits) * 2n, BigInt(start + end)),
    })
  }
  const yearFirst = `${year}-01-01`
  const yearLast = `${year}-12-31`
  const leavers = facts.filter(
    (f) => f.exitDate && f.exitDate >= yearFirst && f.exitDate <= yearLast
  )
  return {
    year,
    months,
    hires: months.reduce((a, m) => a + m.hires, 0),
    exits: exitsYear,
    // Média anual = Σ (início + fim) / 24.
    averageHeadcount: percent(sumStartEnd, 2400n),
    rate: percent(BigInt(exitsYear) * 24n, sumStartEnd),
    byReason: countBy(leavers, (f) => f.exitReason),
    byInitiative: countBy(leavers, (f) => f.exitInitiative),
  }
}
