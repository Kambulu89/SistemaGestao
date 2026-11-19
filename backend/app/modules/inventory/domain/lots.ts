/**
 * Lotes, séries e FEFO (8.8). O lote é uma dimensão do saldo físico e em trânsito; as saídas sem lote indicado são
 * repartidas por **FEFO** (primeiro a expirar, primeiro a sair; sem validade, por ordem de entrada) e o que entra do
 * outro lado do mesmo lançamento (transferência, mudança de estado) leva os mesmos lotes e séries. FEFO/FIFO aqui é
 * a ordem física de saída — não é o método de valorização (8.9).
 */
export const LOT_STATUSES = ['ACTIVE', 'BLOCKED', 'RECALLED'] as const
export type LotStatus = (typeof LOT_STATUSES)[number]

export const LOT_CODE = /^[A-Za-z0-9][A-Za-z0-9._\/-]{0,39}$/

export interface LotFacts {
  id: string
  status: LotStatus
  expiryDate: string | null
  createdAt: string
}

/** Expirado quando a validade é anterior a hoje (o próprio dia da validade ainda conta). */
export const isExpired = (l: Pick<LotFacts, 'expiryDate'>, today: string) =>
  !!l.expiryDate && l.expiryDate < today

/** Pode sair do stock livre (venda, consumo, transferência): activo e dentro da validade. */
export const lotUsable = (l: Pick<LotFacts, 'status' | 'expiryDate'>, today: string) =>
  l.status === 'ACTIVE' && !isExpired(l, today)

/** Ordem FEFO: validade mais próxima primeiro; sem validade no fim; empate pela entrada do lote. */
export function fefoOrder<T extends { lot: LotFacts | null }>(xs: T[]): T[] {
  return [...xs].sort((a, b) => {
    if (!a.lot || !b.lot) return a.lot ? -1 : b.lot ? 1 : 0 // stock sem lote (anterior ao 8.8) no fim
    const ea = a.lot.expiryDate ?? '9999-12-31'
    const eb = b.lot.expiryDate ?? '9999-12-31'
    if (ea !== eb) return ea < eb ? -1 : 1
    return a.lot.createdAt < b.lot.createdAt ? -1 : a.lot.createdAt > b.lot.createdAt ? 1 : 0
  })
}

/**
 * Reparte uma saída por lotes em FEFO. Com `onlyUsable`, ignora lotes bloqueados, recolhidos ou expirados (saídas do
 * livre). Devolve as parcelas e o que não foi possível cobrir.
 */
export function allocateFefo(
  need: bigint,
  candidates: { lot: LotFacts | null; quantity: bigint }[],
  opts: { onlyUsable: boolean; today: string }
): { parts: { lotId: string | null; quantity: bigint }[]; short: bigint } {
  let left = need
  const parts: { lotId: string | null; quantity: bigint }[] = []
  for (const c of fefoOrder(candidates)) {
    if (left === 0n) break
    if (c.quantity <= 0n) continue
    if (opts.onlyUsable && c.lot && !lotUsable(c.lot, opts.today)) continue
    const take = c.quantity < left ? c.quantity : left
    parts.push({ lotId: c.lot?.id ?? null, quantity: take })
    left -= take
  }
  return { parts, short: left }
}

/** Fila de lotes/séries que saíram num lançamento, para dar às entradas do mesmo produto o mesmo lote. */
export class PairingQueue {
  private readonly q = new Map<
    string,
    { lotId: string | null; quantity: bigint; serials: string[] }[]
  >()

  push(key: string, lotId: string | null, quantity: bigint, serials: string[]) {
    const list = this.q.get(key) ?? []
    list.push({ lotId, quantity, serials: [...serials] })
    this.q.set(key, list)
  }

  /** Tira `quantity` da fila, partindo por lote. `short` > 0 se a fila não chegar. */
  take(key: string, quantity: bigint) {
    const list = this.q.get(key) ?? []
    const parts: { lotId: string | null; quantity: bigint; serials: string[] }[] = []
    let left = quantity
    while (left > 0n && list.length) {
      const h = list[0]
      const take = h.quantity < left ? h.quantity : left
      // Séries: uma por unidade (produtos com séries têm unidade inteira).
      const n = h.serials.length ? Number(take / 1_000_000n) : 0
      parts.push({ lotId: h.lotId, quantity: take, serials: h.serials.splice(0, n) })
      h.quantity -= take
      left -= take
      if (h.quantity === 0n) list.shift()
    }
    return { parts, short: left }
  }
}
