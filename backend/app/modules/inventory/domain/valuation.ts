/**
 * Valorização do stock (8.9). Aritmética exacta em inteiros: quantidades em milionésimos da unidade base (6 casas),
 * valores em cêntimos (2 casas) e custo unitário em milionésimos (6 casas). Arredondamento meio-para-cima; o último
 * movimento que esvazia um saldo ou uma camada leva o valor que lá resta (nada fica perdido em arredondamentos).
 *
 * Métodos: custo médio ponderado (por entidade legal, produto e variante), FIFO contabilístico (camadas por ordem de
 * entrada — independente do FEFO físico) e custo específico (camadas por lote).
 */
export const VALUATION_METHODS = ['AVERAGE', 'FIFO', 'SPECIFIC'] as const
export type ValuationMethod = (typeof VALUATION_METHODS)[number]

export const VALUED_BUCKETS = ['UNRESTRICTED', 'BLOCKED', 'QUARANTINE', 'IN_TRANSIT'] as const

const Q = 1_000_000n // quantidade: 6 casas
const C = 1_000_000n // custo unitário: 6 casas

/** Divisão inteira com arredondamento meio-para-cima (sinal preservado). */
export function divRound(n: bigint, d: bigint): bigint {
  if (d === 0n) throw new Error('divisão por zero')
  const neg = n < 0n !== d < 0n
  const a = n < 0n ? -n : n
  const b = d < 0n ? -d : d
  const r = (a + b / 2n) / b
  return neg ? -r : r
}

/** Valor (cêntimos) de uma quantidade a um custo unitário: q × custo, arredondado ao cêntimo. */
export const lineValue = (quantity: bigint, unitCost: bigint) =>
  divRound(quantity * unitCost * 100n, Q * C)

/** Custo unitário (6 casas) de um valor numa quantidade. */
export const unitCostOf = (value: bigint, quantity: bigint) =>
  quantity === 0n ? 0n : divRound(value * Q * C, quantity * 100n)

/** Saída ao custo médio: a parte proporcional do valor do saldo; esvaziar o saldo leva o valor todo. */
export function averageOut(quantity: bigint, pool: { quantity: bigint; value: bigint }) {
  if (quantity >= pool.quantity) return pool.value
  return divRound(pool.value * quantity, pool.quantity)
}

export interface LayerState {
  id: string
  remainingQuantity: bigint
  remainingValue: bigint
}

/** Consome camadas pela ordem dada (FIFO ou as do lote); o resto de cada camada esvaziada vai inteiro. */
export function consumeLayers(quantity: bigint, layers: LayerState[]) {
  let left = quantity
  const parts: { layerId: string; quantity: bigint; value: bigint }[] = []
  for (const l of layers) {
    if (left === 0n) break
    if (l.remainingQuantity <= 0n) continue
    const take = l.remainingQuantity < left ? l.remainingQuantity : left
    const value =
      take === l.remainingQuantity
        ? l.remainingValue
        : divRound(l.remainingValue * take, l.remainingQuantity)
    parts.push({ layerId: l.id, quantity: take, value })
    left -= take
  }
  return { parts, short: left }
}

/** Fila de valor que saiu num lançamento, para valorizar ao mesmo custo o que entra (transferência entre entidades). */
export class ValueQueue {
  private readonly q = new Map<string, { quantity: bigint; value: bigint }[]>()

  push(key: string, quantity: bigint, value: bigint) {
    if (quantity <= 0n) return
    const list = this.q.get(key) ?? []
    list.push({ quantity, value })
    this.q.set(key, list)
  }

  /** Tira `quantity` da fila; devolve o valor e o que faltou. */
  take(key: string, quantity: bigint) {
    const list = this.q.get(key) ?? []
    let left = quantity
    let value = 0n
    while (left > 0n && list.length) {
      const h = list[0]
      const take = h.quantity < left ? h.quantity : left
      const v = take === h.quantity ? h.value : divRound(h.value * take, h.quantity)
      value += v
      h.quantity -= take
      h.value -= v
      left -= take
      if (h.quantity === 0n) list.shift()
    }
    return { value, short: left }
  }
}

/** Texto de cêntimos (2 casas) e de custo unitário (6 casas). */
export const moneyText = (cents: bigint) => {
  const neg = cents < 0n
  const a = neg ? -cents : cents
  return `${neg ? '-' : ''}${a / 100n}.${(a % 100n).toString().padStart(2, '0')}`
}
export const costText = (micro: bigint) => {
  const neg = micro < 0n
  const a = neg ? -micro : micro
  return `${neg ? '-' : ''}${a / C}.${(a % C).toString().padStart(6, '0')}`
}

/** Lê um decimal (texto) com `scale` casas para inteiro; `null` se inválido ou com casas a mais. */
export function parseScaled(raw: unknown, scale: number, allowNegative = false): bigint | null {
  const v = typeof raw === 'number' ? String(raw) : raw
  if (typeof v !== 'string') return null
  const t = v.trim()
  const re = allowNegative ? /^-?\d{1,14}(\.\d+)?$/ : /^\d{1,14}(\.\d+)?$/
  if (!re.test(t)) return null
  const neg = t.startsWith('-')
  const [i, f = ''] = (neg ? t.slice(1) : t).split('.')
  if (f.length > scale) return null
  const n =
    BigInt(i) * 10n ** BigInt(scale) + BigInt((f + '0'.repeat(scale)).slice(0, scale) || '0')
  return neg ? -n : n
}
