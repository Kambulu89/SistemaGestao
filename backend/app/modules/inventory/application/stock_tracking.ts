import { ApiError, type ErrorDetail } from '#shared/http/api_error'
import { isUuid } from '#shared/db/sql'
import type { TenantScope } from '#modules/tenancy/index'
import {
  keyOf,
  quantityText,
  type PostingLine,
  type PostingType,
} from '#modules/inventory/domain/stock'
import {
  allocateFefo,
  isExpired,
  LOT_CODE,
  lotUsable,
  PairingQueue,
  type LotFacts,
  type LotStatus,
} from '#modules/inventory/domain/lots'

/*
 * Lotes e séries no motor de stock (8.8). Corre depois das referências e dos bloqueios (advisory locks) e antes da
 * verificação dos saldos: resolve o lote de cada linha (indicado, por código — criado nas entradas — ou repartido em
 * FEFO nas saídas), as séries de cada unidade (indicadas ou escolhidas por ordem de entrada) e passa às entradas do
 * mesmo lançamento os lotes e séries que saíram (transferência, mudança de estado).
 */

export interface TrackedLine extends PostingLine {
  lotCode?: string | null
  expiryDate?: string | null
}

const LOT_BUCKETS = ['UNRESTRICTED', 'BLOCKED', 'QUARANTINE', 'IN_TRANSIT']
const ONE = 1_000_000n
const today = () => new Date().toISOString().slice(0, 10)
const DATE = /^\d{4}-\d{2}-\d{2}$/

const big = (v: unknown) => {
  const [i, f = ''] = String(v ?? '0').split('.')
  const neg = i.startsWith('-')
  const n = BigInt(neg ? i.slice(1) : i) * ONE + BigInt((f + '000000').slice(0, 6))
  return neg ? -n : n
}

/** Valida o formato dos campos de lote e séries vindos do pedido. */
export function trackingInputIssues(l: any, i: number): ErrorDetail[] {
  const out: ErrorDetail[] = []
  const at = (path: string, message: string) =>
    out.push({ path: `lines.${i}.${path}`, code: 'INVALID', message })
  if (l?.lotId !== null && l?.lotId !== undefined && !isUuid(l.lotId)) at('lotId', 'Lote inválido.')
  if (l?.lotCode !== null && l?.lotCode !== undefined && !LOT_CODE.test(String(l.lotCode)))
    at('lotCode', 'Código de lote: letras, algarismos, . _ / -, até 40.')
  if (l?.expiryDate && (!DATE.test(l.expiryDate) || Number.isNaN(Date.parse(l.expiryDate))))
    at('expiryDate', 'Validade inválida.')
  if (l?.serials !== undefined && l?.serials !== null) {
    const s = l.serials
    if (
      !Array.isArray(s) ||
      s.some((x: unknown) => typeof x !== 'string' || !x.trim() || x.length > 80) ||
      new Set(s.map((x: string) => x.trim())).size !== s.length
    )
      at('serials', 'Números de série sem vazios nem repetidos (até 80).')
  }
  return out
}

interface LotRow extends LotFacts {
  productId: string
  variantId: string | null
  code: string
}
const lotRow = (r: any): LotRow => ({
  id: r.id,
  productId: r.product_id,
  variantId: r.variant_id ?? null,
  code: r.code,
  status: r.status as LotStatus,
  expiryDate: r.expiry_text ?? null,
  createdAt: new Date(r.created_at).toISOString(),
})
const LOT_SELECT = `select id, product_id, variant_id, code, status, expiry_date::text as expiry_text, created_at
  from stock_lots`

/** Lote por código (cria-o nas entradas, se não existir). */
async function lotByCode(
  scope: TenantScope,
  l: TrackedLine,
  create: boolean,
  trackExpiry: boolean
): Promise<LotRow | ErrorDetail> {
  const { tenantId, userId } = scope.context
  const code = String(l.lotCode).trim()
  const find = async () =>
    (
      await scope.trx.rawQuery(
        `${LOT_SELECT} where tenant_id = ? and product_id = ? and variant_id is not distinct from ? and code = ?`,
        [tenantId, l.productId, l.variantId, code] as never[]
      )
    ).rows[0] as any
  let r = await find()
  if (!r) {
    if (!create)
      return { path: 'lotCode', code: 'LOT_NOT_FOUND', message: `O lote ${code} não existe.` }
    if (trackExpiry && !l.expiryDate)
      return {
        path: 'expiryDate',
        code: 'REQUIRED',
        message: `Lote ${code} novo: indique a validade.`,
      }
    await scope.trx.rawQuery(
      `insert into stock_lots (tenant_id, product_id, variant_id, code, expiry_date, created_by, updated_by)
       values (?, ?, ?, ?, ?, ?, ?) on conflict do nothing`,
      [tenantId, l.productId, l.variantId, code, l.expiryDate ?? null, userId, userId] as never[]
    )
    r = await find()
  }
  const lot = lotRow(r)
  if (l.expiryDate && lot.expiryDate !== l.expiryDate)
    return {
      path: 'expiryDate',
      code: 'LOT_EXPIRY_MISMATCH',
      message: `O lote ${code} tem validade ${lot.expiryDate ?? 'nenhuma'}.`,
    }
  return lot
}

/**
 * Resolve lotes e séries das linhas de um lançamento (os saldos já estão bloqueados por armazém/produto/variante).
 * Devolve as linhas finais (podem ser mais: uma saída pode repartir-se por vários lotes).
 */
export async function resolveTracking(
  scope: TenantScope,
  type: PostingType,
  input: TrackedLine[],
  pmap: Map<string, any>
): Promise<PostingLine[]> {
  const { tenantId } = scope.context
  const day = today()
  const issues: ErrorDetail[] = []
  const lots = new Map<string, LotRow>()
  const ids = [...new Set(input.map((l) => l.lotId).filter(Boolean))] as string[]
  if (ids.length) {
    const r = await scope.trx.rawQuery(
      `${LOT_SELECT} where tenant_id = ? and id = any(?::uuid[])`,
      [tenantId, ids] as never[]
    )
    for (const x of r.rows as any[]) lots.set(x.id, lotRow(x))
  }
  const creates = type === 'RECEIPT' || type === 'ADJUSTMENT'
  const outbound = type === 'ISSUE' || type === 'TRANSFER_OUT'
  const lines: TrackedLine[] = []
  for (const [i, l] of input.entries()) {
    const at = (path: string, code: string, message: string) =>
      issues.push({ path: `lines.${i}.${path}`, code, message })
    const p = pmap.get(l.productId)
    const lotBucket = LOT_BUCKETS.includes(l.bucket)
    const x: TrackedLine = {
      ...l,
      lotId: l.lotId ?? null,
      serials: l.serials?.map((s) => s.trim()),
    }
    if (!lotBucket) {
      if (x.lotId || x.lotCode)
        at('lotId', 'LOT_NOT_ALLOWED', 'Reservado e previsto contam-se sem lote.')
      if (x.serials?.length)
        at('serials', 'NOT_ALLOWED', 'Reservado e previsto contam-se sem séries.')
      lines.push(x)
      continue
    }
    if (!p.track_lots && (x.lotId || x.lotCode))
      at('lotId', 'NOT_TRACKED', `${p.sku} não controla lotes.`)
    if (!p.track_serials && x.serials?.length)
      at('serials', 'NOT_TRACKED', `${p.sku} não controla séries.`)
    if (p.track_serials && x.quantity % ONE !== 0n)
      at('quantity', 'SERIAL_UNITS', `${p.sku} conta-se por unidade (séries).`)
    if (
      x.serials?.length &&
      BigInt(x.serials.length) * ONE !== (x.quantity < 0n ? -x.quantity : x.quantity)
    )
      at(
        'serials',
        'SERIAL_COUNT',
        'Uma série por unidade: o número de séries não bate com a quantidade.'
      )
    if (p.track_lots && !x.lotId && x.lotCode) {
      const r = await lotByCode(scope, x, creates && x.quantity > 0n, Boolean(p.track_expiry))
      if ('path' in r) issues.push({ ...r, path: `lines.${i}.${r.path}` })
      else {
        lots.set(r.id, r)
        x.lotId = r.id
      }
    }
    if (x.lotId) {
      const lot = lots.get(x.lotId)
      if (!lot || lot.productId !== x.productId || lot.variantId !== x.variantId)
        at('lotId', 'LOT_MISMATCH', 'O lote não é deste produto/variante.')
      else if (type !== 'REVERSAL' && x.bucket === 'UNRESTRICTED') {
        if (x.quantity > 0n && lot.status !== 'ACTIVE')
          at(
            'lotId',
            'LOT_BLOCKED',
            `O lote ${lot.code} está ${lot.status === 'RECALLED' ? 'recolhido' : 'bloqueado'}: não entra no stock livre.`
          )
        if (x.quantity < 0n && outbound && !lotUsable(lot, day))
          at(
            'lotId',
            isExpired(lot, day) && lot.status === 'ACTIVE' ? 'LOT_EXPIRED' : 'LOT_BLOCKED',
            isExpired(lot, day) && lot.status === 'ACTIVE'
              ? `O lote ${lot.code} expirou em ${lot.expiryDate}: não sai do stock livre.`
              : `O lote ${lot.code} está bloqueado/recolhido: não sai do stock livre.`
          )
      }
    }
    lines.push(x)
  }
  if (issues.length) throw ApiError.validation(issues)

  // Séries que saem/entram neste lançamento.
  const removed = new Set<string>()
  const used = new Set<string>()
  const queue = new PairingQueue()
  const out: PostingLine[] = []
  const pairKey = (l: PostingLine) => `${l.productId}|${l.variantId ?? ''}`
  const taken = new Map<string, bigint>() // consumo de saldos nas saídas deste lançamento

  // 1) Saídas: lote em FEFO quando não indicado, séries indicadas ou por ordem de entrada.
  for (const [i, l] of lines.entries()) {
    if (l.quantity > 0n) continue
    const p = pmap.get(l.productId)
    const tracked = LOT_BUCKETS.includes(l.bucket) && (p.track_lots || p.track_serials)
    if (!tracked) {
      out.push(l)
      continue
    }
    const need = -l.quantity
    let parts: { lotId: string | null; quantity: bigint; serials?: string[] }[]
    if (l.serials?.length) {
      // As séries indicadas mandam: cada uma tem de estar neste lugar; o lote é o delas.
      const r = await scope.trx.rawQuery(
        `select serial, lot_id, status, warehouse_id, location_id, bucket from stock_serials
          where tenant_id = ? and product_id = ? and serial = any(?::text[])`,
        [tenantId, l.productId, l.serials] as never[]
      )
      const found = new Map((r.rows as any[]).map((s) => [s.serial as string, s]))
      const byLot = new Map<string, string[]>()
      for (const s of l.serials) {
        const row = found.get(s)
        if (
          !row ||
          row.status !== 'IN_STOCK' ||
          row.warehouse_id !== l.warehouseId ||
          (row.location_id ?? null) !== l.locationId ||
          row.bucket !== l.bucket ||
          (l.lotId && row.lot_id !== l.lotId) ||
          used.has(`${l.productId}|${s}`)
        ) {
          issues.push({
            path: `lines.${i}.serials`,
            code: 'SERIAL_NOT_HERE',
            message: `A série ${s} não está em stock neste lugar.`,
          })
          continue
        }
        used.add(`${l.productId}|${s}`)
        const k = row.lot_id ?? ''
        byLot.set(k, [...(byLot.get(k) ?? []), s])
      }
      parts = [...byLot].map(([lot, ss]) => ({
        lotId: lot || null,
        quantity: BigInt(ss.length) * ONE,
        serials: ss,
      }))
    } else if (p.track_lots && !l.lotId) {
      const r = await scope.trx.rawQuery(
        `select b.lot_id, b.qty_unrestricted, b.qty_blocked, b.qty_quarantine, b.qty_in_transit,
            lt.status, lt.expiry_date::text as expiry_text, lt.created_at
           from stock_balances b left join stock_lots lt on lt.tenant_id = b.tenant_id and lt.id = b.lot_id
          where b.tenant_id = ? and b.warehouse_id = ? and b.location_id is not distinct from ?
            and b.product_id = ? and b.variant_id is not distinct from ?`,
        [tenantId, l.warehouseId, l.locationId, l.productId, l.variantId] as never[]
      )
      const col = `qty_${l.bucket.toLowerCase()}`
      const cands = (r.rows as any[]).map((b) => {
        const k = keyOf({ ...l, lotId: b.lot_id ?? null }) + `#${l.bucket}`
        return {
          lot: b.lot_id
            ? {
                id: b.lot_id as string,
                status: b.status as LotStatus,
                expiryDate: (b.expiry_text as string) ?? null,
                createdAt: new Date(b.created_at).toISOString(),
              }
            : null,
          quantity: big(b[col]) - (taken.get(k) ?? 0n),
        }
      })
      const a = allocateFefo(need, cands, {
        onlyUsable: outbound && l.bucket === 'UNRESTRICTED',
        today: day,
      })
      if (a.short > 0n)
        throw new ApiError(
          409,
          'INSUFFICIENT_STOCK',
          `Stock insuficiente de ${p.sku} (${l.bucket}) em lotes que podem sair: faltam ${quantityText(a.short)} (lotes bloqueados, recolhidos ou expirados não saem).`
        )
      parts = a.parts
    } else parts = [{ lotId: l.lotId ?? null, quantity: need }]
    for (const part of parts) {
      const k = keyOf({ ...l, lotId: part.lotId }) + `#${l.bucket}`
      taken.set(k, (taken.get(k) ?? 0n) + part.quantity)
      let serials = part.serials
      if (p.track_serials && !serials) {
        const n = Number(part.quantity / ONE)
        const r = await scope.trx.rawQuery(
          `select serial from stock_serials where tenant_id = ? and product_id = ? and status = 'IN_STOCK'
              and warehouse_id = ? and location_id is not distinct from ? and lot_id is not distinct from ?
              and bucket = ? and not (serial = any(?::text[]))
            order by updated_at, serial limit ?`,
          [
            tenantId,
            l.productId,
            l.warehouseId,
            l.locationId,
            part.lotId,
            l.bucket,
            [...used].filter((u) => u.startsWith(`${l.productId}|`)).map((u) => u.slice(37)),
            n,
          ] as never[]
        )
        serials = (r.rows as any[]).map((s) => s.serial as string)
        if (serials.length < n)
          issues.push({
            path: `lines.${i}.serials`,
            code: 'SERIALS_MISSING',
            message: `Não há ${n} série(s) de ${p.sku} registadas neste lugar.`,
          })
        for (const s of serials) used.add(`${l.productId}|${s}`)
      }
      for (const s of serials ?? []) removed.add(`${l.productId}|${s}`)
      queue.push(pairKey(l), part.lotId, part.quantity, serials ?? [])
      out.push({ ...l, lotId: part.lotId, quantity: -part.quantity, serials: serials ?? [] })
    }
  }
  if (issues.length) throw ApiError.validation(issues)

  // 2) Entradas: lote e séries indicados, ou os que saíram neste lançamento.
  for (const [i, l] of lines.entries()) {
    if (l.quantity < 0n) continue
    const p = pmap.get(l.productId)
    const tracked = LOT_BUCKETS.includes(l.bucket) && (p.track_lots || p.track_serials)
    if (!tracked) {
      out.push(l)
      continue
    }
    const lotOk = !p.track_lots || !!l.lotId
    const serialOk = !p.track_serials || !!l.serials?.length
    let parts: { lotId: string | null; quantity: bigint; serials: string[] }[]
    if (lotOk && serialOk)
      parts = [{ lotId: l.lotId ?? null, quantity: l.quantity, serials: l.serials ?? [] }]
    else {
      const t = queue.take(pairKey(l), l.quantity)
      if (t.short > 0n) {
        issues.push({
          path: `lines.${i}.${p.track_lots && !l.lotId ? 'lotId' : 'serials'}`,
          code: p.track_lots && !l.lotId ? 'LOT_REQUIRED' : 'SERIALS_REQUIRED',
          message:
            p.track_lots && !l.lotId
              ? `${p.sku} controla lotes: indique o lote da entrada.`
              : `${p.sku} controla séries: indique a série de cada unidade.`,
        })
        continue
      }
      let explicit = [...(l.serials ?? [])]
      parts = t.parts.map((x) => {
        const n = Number(x.quantity / ONE)
        const serials = explicit.length ? explicit.splice(0, n) : x.serials
        return { lotId: l.lotId ?? x.lotId, quantity: x.quantity, serials }
      })
    }
    for (const part of parts) {
      if (p.track_serials) {
        const r = await scope.trx.rawQuery(
          `select serial from stock_serials where tenant_id = ? and product_id = ? and status = 'IN_STOCK'
              and serial = any(?::text[])`,
          [tenantId, l.productId, part.serials] as never[]
        )
        for (const s of r.rows as any[])
          if (!removed.has(`${l.productId}|${s.serial}`))
            issues.push({
              path: `lines.${i}.serials`,
              code: 'SERIAL_IN_STOCK',
              message: `A série ${s.serial} já está em stock.`,
            })
        for (const s of part.serials) {
          if (used.has(`${l.productId}|+${s}`))
            issues.push({
              path: `lines.${i}.serials`,
              code: 'SERIAL_DUPLICATE',
              message: `A série ${s} entra duas vezes.`,
            })
          used.add(`${l.productId}|+${s}`)
        }
      }
      out.push({ ...l, lotId: part.lotId, quantity: part.quantity, serials: part.serials })
    }
  }
  if (issues.length) throw ApiError.validation(issues)
  return out.map((l) => ({
    warehouseId: l.warehouseId,
    locationId: l.locationId,
    productId: l.productId,
    variantId: l.variantId,
    bucket: l.bucket,
    quantity: l.quantity,
    lotId: l.lotId ?? null,
    serials: l.serials ?? [],
  }))
}

/** Depois de gravar os movimentos: estado de cada série e o seu histórico (saídas primeiro, depois entradas). */
export async function applySerials(scope: TenantScope, postingId: string, lines: PostingLine[]) {
  const { tenantId, userId } = scope.context
  const order = lines
    .map((l, i) => ({ l, lineNo: i + 1 }))
    .filter((x) => x.l.serials?.length)
    .sort((a, b) => (a.l.quantity < 0n ? 0 : 1) - (b.l.quantity < 0n ? 0 : 1))
  for (const { l, lineNo } of order) {
    for (const s of l.serials!) {
      let id: string
      if (l.quantity < 0n) {
        const r = await scope.trx.rawQuery(
          `update stock_serials set status = 'OUT', warehouse_id = null, location_id = null, bucket = null,
              last_posting_id = ?, updated_at = now(), updated_by = ?, version = version + 1
            where tenant_id = ? and product_id = ? and serial = ? and status = 'IN_STOCK' returning id`,
          [postingId, userId, tenantId, l.productId, s] as never[]
        )
        if (!r.rows.length)
          throw ApiError.conflict('SERIAL_NOT_HERE', `A série ${s} já não está em stock.`)
        id = (r.rows[0] as any).id
      } else {
        const r = await scope.trx.rawQuery(
          `insert into stock_serials (tenant_id, product_id, variant_id, serial, lot_id, status, warehouse_id,
              location_id, bucket, last_posting_id, created_by, updated_by)
           values (?, ?, ?, ?, ?, 'IN_STOCK', ?, ?, ?, ?, ?, ?)
           on conflict (tenant_id, product_id, serial) do update set
              variant_id = excluded.variant_id, lot_id = excluded.lot_id, status = 'IN_STOCK',
              warehouse_id = excluded.warehouse_id, location_id = excluded.location_id, bucket = excluded.bucket,
              last_posting_id = excluded.last_posting_id, updated_at = now(), updated_by = excluded.updated_by,
              version = stock_serials.version + 1
            where stock_serials.status = 'OUT'
           returning id`,
          [
            tenantId,
            l.productId,
            l.variantId,
            s,
            l.lotId ?? null,
            l.warehouseId,
            l.locationId,
            l.bucket,
            postingId,
            userId,
            userId,
          ] as never[]
        )
        if (!r.rows.length)
          throw ApiError.conflict('SERIAL_IN_STOCK', `A série ${s} já está em stock.`)
        id = (r.rows[0] as any).id
      }
      await scope.trx.rawQuery(
        `insert into stock_serial_movements (tenant_id, serial_id, posting_id, line_no, delta, warehouse_id,
            location_id, lot_id, bucket, created_by, updated_by) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          tenantId,
          id,
          postingId,
          lineNo,
          l.quantity < 0n ? -1 : 1,
          l.warehouseId,
          l.locationId,
          l.lotId ?? null,
          l.bucket,
          userId,
          userId,
        ] as never[]
      )
    }
  }
}

/** Séries de cada linha de um lançamento (para o estorno). */
export async function postingSerials(scope: TenantScope, postingId: string) {
  const r = await scope.trx.rawQuery(
    `select m.line_no, s.serial from stock_serial_movements m
       join stock_serials s on s.tenant_id = m.tenant_id and s.id = m.serial_id
      where m.tenant_id = ? and m.posting_id = ? order by m.line_no, s.serial`,
    [scope.context.tenantId, postingId]
  )
  const out = new Map<number, string[]>()
  for (const x of r.rows as any[])
    out.set(Number(x.line_no), [...(out.get(Number(x.line_no)) ?? []), x.serial])
  return out
}
