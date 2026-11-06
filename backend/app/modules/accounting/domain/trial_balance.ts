/**
 * Balancete (puro). Os valores vêm só das contas movimentáveis (folhas, onde há linhas); as contas-mãe mostram a soma
 * dos seus descendentes e **nunca** entram nos totais, para não contar o mesmo movimento duas vezes.
 */
export interface TbAccount {
  id: string
  parentId: string | null
  code: string
  name: string
  level: string
  postable: boolean
}

/** Movimentos de uma conta (montantes escalados em BigInt): saldo anterior e movimentos do intervalo. */
export interface TbAmounts {
  opening: bigint
  debit: bigint
  credit: bigint
}

export interface TbRow {
  accountId: string
  code: string
  name: string
  level: string
  depth: number
  postable: boolean
  opening: bigint
  debit: bigint
  credit: bigint
  closing: bigint
}

const ZERO: TbAmounts = { opening: 0n, debit: 0n, credit: 0n }

/**
 * Linhas do balancete em árvore (pai antes dos filhos, por código).
 * - `analytic`: todas as contas até às folhas;
 * - `synthetic`: só até `maxDepth` (1 = classes), cada linha com a soma da sua subárvore.
 * Contas sem saldo nem movimentos são omitidas, salvo `includeZero`.
 */
export function buildTrialBalance(
  accounts: TbAccount[],
  amounts: Map<string, TbAmounts>,
  options: { mode: 'analytic' | 'synthetic'; maxDepth?: number; includeZero?: boolean }
) {
  const ids = new Set(accounts.map((a) => a.id))
  const children = new Map<string | null, TbAccount[]>()
  for (const a of accounts) {
    const parent = a.parentId && ids.has(a.parentId) ? a.parentId : null
    children.set(parent, [...(children.get(parent) ?? []), a])
  }
  const memo = new Map<string, TbAmounts>()
  // Soma da subárvore: a conta (se movimentável) mais os filhos.
  const subtotal = (a: TbAccount, seen = new Set<string>()): TbAmounts => {
    const cached = memo.get(a.id)
    if (cached) return cached
    if (seen.has(a.id)) return ZERO
    seen.add(a.id)
    const own = a.postable ? (amounts.get(a.id) ?? ZERO) : ZERO
    const sum = { ...own }
    for (const c of children.get(a.id) ?? []) {
      const s = subtotal(c, seen)
      sum.opening += s.opening
      sum.debit += s.debit
      sum.credit += s.credit
    }
    memo.set(a.id, sum)
    return sum
  }
  const rows: TbRow[] = []
  const maxDepth =
    options.mode === 'synthetic' ? Math.max(1, options.maxDepth ?? 1) : Number.POSITIVE_INFINITY
  const walk = (parent: string | null, depth: number) => {
    for (const a of (children.get(parent) ?? []).sort((x, y) => x.code.localeCompare(y.code))) {
      const s = subtotal(a)
      const closing = s.opening + s.debit - s.credit
      if (options.includeZero || s.opening !== 0n || s.debit !== 0n || s.credit !== 0n)
        rows.push({
          accountId: a.id,
          code: a.code,
          name: a.name,
          level: a.level,
          depth,
          postable: a.postable,
          ...s,
          closing,
        })
      if (depth < maxDepth) walk(a.id, depth + 1)
    }
  }
  walk(null, 1)

  // Totais: só as contas movimentáveis (folhas com linhas), uma vez cada.
  const totals = { opening: 0n, debit: 0n, credit: 0n, closingDebit: 0n, closingCredit: 0n }
  for (const a of accounts) {
    if (!a.postable) continue
    const m = amounts.get(a.id)
    if (!m) continue
    totals.opening += m.opening
    totals.debit += m.debit
    totals.credit += m.credit
    const closing = m.opening + m.debit - m.credit
    if (closing > 0n) totals.closingDebit += closing
    else totals.closingCredit -= closing
  }
  // Movimentos de contas que já não estão na árvore (não deveria acontecer) entram nos totais e são assinalados.
  const orphans = [...amounts.keys()].filter((id) => !ids.has(id))
  return {
    rows,
    totals,
    balanced:
      totals.debit === totals.credit &&
      totals.opening === 0n &&
      totals.closingDebit === totals.closingCredit,
    orphans,
  }
}
