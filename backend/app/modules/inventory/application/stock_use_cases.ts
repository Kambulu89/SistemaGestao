import { randomUUID } from 'node:crypto'
import { ApiError } from '#core/http/api_error'
import type { OutboxWriter } from '#core/outbox/index'
import type { TenantContext, TenantScope, TenantUnitOfWork } from '#core/tenancy/index'
import {
  costText,
  fromDb,
  parseCost,
  parseQty,
  parseSignedQty,
  qtyText,
} from '#modules/inventory/domain/decimal'
import {
  nextCost,
  reservationStatus,
  sourceIssues,
  MAX_REASON,
  type Issue,
  type MovementKind,
} from '#modules/inventory/domain/stock'
import type {
  BalanceFilter,
  BalanceRow,
  BalanceView,
  LedgerStore,
  LotStore,
  Movement,
  MovementFilter,
  References,
  Reservation,
  ReservationFilter,
  ReservationStore,
  VariantRef,
  WarehouseStore,
} from '#modules/inventory/application/ports'
import { inventoryValidation } from '#modules/inventory/application/warehouse_use_cases'

const MAX_PAGE = 200

const fail = (path: string, code: string, message: string) =>
  inventoryValidation([{ path, code, message }])

export interface Clock {
  now(): Date
}

export interface Source {
  type: string
  id: string
  lineId: string | null
  effect: string
}

/** Comando de movimento: usado pela API (ajustes, reversões) e pelos outros módulos (recepções, expedições). */
export interface PostCommand {
  kind: Extract<MovementKind, 'RECEIPT' | 'ISSUE' | 'ADJUSTMENT' | 'REVERSAL'>
  variantId: string
  locationId: string
  lotId: string | null
  /** Quantidade com sinal, em texto decimal (até 6 casas). */
  quantityDelta: string
  /** Custo unitário (até 4 casas); em saídas e reversões vem do custo médio ou do movimento original. */
  unitCost?: string | null
  source: Source
  reason?: string | null
  /** Reversão: o movimento revertido e o seu custo original. */
  reversal?: { movementId: string; unitCost: string }
  /** Saída que consome (parte de) uma reserva. */
  reservationId?: string | null
}

export interface PostResult {
  movement: Movement
  idempotent: boolean
}

export interface ReserveInput {
  variantId: string
  locationId: string
  lotId?: string | null
  quantity: string
  source: { type: string; id: string; lineId?: string | null }
  expiresAt?: Date | null
}

/**
 * Livro de movimentos, saldos e reservas (M07). Cada movimento actualiza livro, saldo e custo médio **na mesma transacção**
 * e sob bloqueio da linha de saldo (nunca há duas escritas concorrentes sobre o mesmo saldo). Repetir um comando com a
 * mesma origem devolve o movimento já lançado (idempotente).
 */
export class StockUseCases {
  constructor(
    private readonly uow: TenantUnitOfWork,
    private readonly warehouses: WarehouseStore,
    private readonly lots: LotStore,
    private readonly ledger: LedgerStore,
    private readonly reservations: ReservationStore,
    private readonly references: References,
    private readonly outbox: OutboxWriter,
    private readonly clock: Clock
  ) {}

  // --- consultas -----------------------------------------------------------------------------

  balances(context: TenantContext, filter: Partial<BalanceFilter>) {
    return this.uow.run(
      (scope) =>
        this.ledger.listBalances(scope, {
          ...filter,
          limit: Math.min(filter.limit ?? 50, MAX_PAGE),
          offset: filter.offset ?? 0,
        }),
      context
    )
  }

  movements(context: TenantContext, filter: Partial<MovementFilter>) {
    return this.uow.run(
      (scope) =>
        this.ledger.listMovements(scope, {
          ...filter,
          limit: Math.min(filter.limit ?? 50, MAX_PAGE),
          offset: filter.offset ?? 0,
        }),
      context
    )
  }

  listReservations(context: TenantContext, filter: Partial<ReservationFilter>) {
    return this.uow.run(
      (scope) =>
        this.reservations.list(scope, {
          ...filter,
          limit: Math.min(filter.limit ?? 50, MAX_PAGE),
          offset: filter.offset ?? 0,
        }),
      context
    )
  }

  /** O saldo de um local/lote e a soma do livro: têm de coincidir (reconciliação). */
  reconcile(
    context: TenantContext,
    key: { variantId: string; locationId: string; lotId: string | null }
  ): Promise<{ onHand: string; ledger: string; reserved: string }> {
    return this.uow.run(async (scope) => {
      const { items } = await this.ledger.listBalances(scope, {
        variantId: key.variantId,
        locationId: key.locationId,
        ...(key.lotId ? { lotId: key.lotId } : {}),
        limit: 200,
        offset: 0,
      })
      const row = items.find((b) => b.lotId === key.lotId)
      return {
        onHand: row?.onHand ?? qtyText(0n),
        reserved: row?.reserved ?? qtyText(0n),
        ledger: qtyText(fromDb(await this.ledger.ledgerSum(scope, key), 6)),
      }
    }, context)
  }

  // --- movimentos ----------------------------------------------------------------------------

  /** Ajuste manual: `quantityDelta` com sinal e motivo obrigatório. `reference` torna o pedido repetível. */
  async adjust(
    context: TenantContext,
    input: {
      variantId: string
      locationId: string
      lotId?: string | null
      quantityDelta: string
      unitCost?: string | null
      reason: string
      reference?: string | null
    }
  ): Promise<PostResult> {
    const reason = typeof input.reason === 'string' ? input.reason.trim() : ''
    if (!reason || reason.length > MAX_REASON) {
      throw fail('reason', 'REASON_REQUIRED', `Indique o motivo (até ${MAX_REASON} caracteres).`)
    }
    return this.uow.run(
      (scope) =>
        this.postInScope(scope, {
          kind: 'ADJUSTMENT',
          variantId: input.variantId,
          locationId: input.locationId,
          lotId: input.lotId ?? null,
          quantityDelta: input.quantityDelta,
          unitCost: input.unitCost ?? null,
          source: {
            type: 'ADJUSTMENT',
            id: input.reference ?? randomUUID(),
            lineId: null,
            effect: 'MAIN',
          },
          reason,
        }),
      context
    )
  }

  /** Reverte um movimento com um movimento oposto ao custo original (o livro nunca se edita). Reverter duas vezes é idempotente. */
  async reverse(context: TenantContext, movementId: string, reason: string): Promise<PostResult> {
    const text = typeof reason === 'string' ? reason.trim() : ''
    if (!text || text.length > MAX_REASON) {
      throw fail('reason', 'REASON_REQUIRED', `Indique o motivo (até ${MAX_REASON} caracteres).`)
    }
    return this.uow.run(async (scope) => {
      const original = await this.ledger.findMovement(scope, movementId)
      if (!original) throw ApiError.notFound()
      if (original.kind === 'REVERSAL') {
        throw ApiError.conflict('REVERSAL_OF_REVERSAL', 'Uma reversão não se reverte.')
      }
      return this.postInScope(scope, {
        kind: 'REVERSAL',
        variantId: original.variantId,
        locationId: original.locationId,
        lotId: original.lotId,
        quantityDelta: qtyText(-fromDb(original.quantityDelta, 6)),
        source: { type: 'REVERSAL', id: original.id, lineId: null, effect: 'MAIN' },
        reason: text,
        reversal: { movementId: original.id, unitCost: original.unitCost },
      })
    }, context)
  }

  /**
   * Lança um movimento na transacção do chamador (recepções, expedições e inventários chamam isto dentro da sua).
   * Valida variante, local, lote e saldo; actualiza livro, saldo, custo e reserva consumida de forma atómica.
   */
  async postInScope(scope: TenantScope, cmd: PostCommand): Promise<PostResult> {
    const context = scope.context
    const issues: Issue[] = sourceIssues({ sourceType: cmd.source.type })
    const delta = parseSignedQty(cmd.quantityDelta)
    if (delta === null || delta === 0n) {
      issues.push({
        path: 'quantityDelta',
        code: 'INVALID_QUANTITY',
        message: 'Quantidade com até 6 casas e diferente de zero.',
      })
    }
    const givenCost =
      cmd.unitCost === null || cmd.unitCost === undefined ? null : parseCost(cmd.unitCost)
    if (cmd.unitCost !== null && cmd.unitCost !== undefined && givenCost === null) {
      issues.push({
        path: 'unitCost',
        code: 'INVALID_COST',
        message: 'Custo com até 4 casas, não negativo.',
      })
    }
    if (delta !== null && delta !== 0n) {
      const positive = delta > 0n
      if (
        (cmd.kind === 'RECEIPT' && !positive) ||
        (cmd.kind === 'ISSUE' && positive) ||
        (cmd.kind === 'REVERSAL' && !cmd.reversal)
      ) {
        issues.push({
          path: 'quantityDelta',
          code: 'KIND_SIGN_MISMATCH',
          message: 'O sinal da quantidade contradiz o tipo de movimento.',
        })
      }
    }
    if (issues.length > 0) throw inventoryValidation(issues)
    const amount = delta as bigint

    // Repetir a mesma origem não duplica o efeito: devolve o movimento já lançado.
    const existing = await this.ledger.findBySource(scope, cmd.source)
    if (existing) {
      if (
        existing.variantId !== cmd.variantId ||
        existing.locationId !== cmd.locationId ||
        existing.lotId !== cmd.lotId ||
        fromDb(existing.quantityDelta, 6) !== amount
      ) {
        throw ApiError.conflict('SOURCE_CONFLICT', 'Esta origem já lançou um movimento diferente.')
      }
      return { movement: existing, idempotent: true }
    }

    const location = await this.warehouses.findLocation(scope, cmd.locationId)
    if (!location) throw fail('locationId', 'UNKNOWN_LOCATION', 'O local não existe.')
    if (cmd.kind !== 'REVERSAL' && (!location.active || !location.warehouseActive)) {
      throw ApiError.conflict('LOCATION_INACTIVE', 'O local ou o armazém está desactivado.')
    }
    const variant = await this.requireStocked(context, cmd.variantId)
    await this.requirePrecision(context, variant, amount < 0n ? -amount : amount)
    await this.requireLot(scope, variant, cmd.lotId, cmd.kind === 'ISSUE')

    const balance = await this.ledger.lockBalance(scope, {
      variantId: cmd.variantId,
      locationId: cmd.locationId,
      lotId: cmd.lotId,
    })
    const cost = await this.ledger.lockCost(scope, location.warehouseId, cmd.variantId)

    const onHand = fromDb(balance.onHand, 6)
    let reserved = fromDb(balance.reserved, 6)
    if (cmd.reservationId) {
      if (cmd.kind !== 'ISSUE') {
        throw fail('reservationId', 'RESERVATION_NOT_ALLOWED', 'Só uma saída consome uma reserva.')
      }
      reserved -= await this.consumeReservation(scope, cmd, -amount)
    }
    const nextOnHand = onHand + amount
    if (amount < 0n && !location.allowNegative && nextOnHand < reserved) {
      const available = onHand - fromDb(balance.reserved, 6)
      throw new ApiError(409, 'INSUFFICIENT_STOCK', 'Stock disponível insuficiente.', [
        {
          path: 'quantityDelta',
          code: 'INSUFFICIENT_STOCK',
          message: `Disponível: ${qtyText(available < 0n ? 0n : available)}.`,
        },
      ])
    }

    const reversalCost = cmd.reversal ? parseCost(cmd.reversal.unitCost) : null
    let unitCost: bigint
    if (reversalCost !== null) unitCost = reversalCost
    else if (amount < 0n) unitCost = cost.avgCost
    else unitCost = givenCost ?? (cmd.kind === 'RECEIPT' ? 0n : cost.avgCost)

    const movement = await this.ledger.insertMovement(scope, {
      organizationId: location.organizationId,
      variantId: cmd.variantId,
      locationId: cmd.locationId,
      lotId: cmd.lotId,
      quantityDelta: qtyText(amount),
      unitCost: costText(unitCost),
      sourceType: cmd.source.type,
      sourceId: cmd.source.id,
      sourceLineId: cmd.source.lineId,
      effect: cmd.source.effect,
      kind: cmd.kind,
      reversedMovementId: cmd.reversal?.movementId ?? null,
      reason: cmd.reason ?? null,
    })
    await this.ledger.saveBalance(scope, balance.id, qtyText(nextOnHand), qtyText(reserved))
    await this.ledger.saveCost(
      scope,
      location.warehouseId,
      cmd.variantId,
      nextCost(cost, amount, unitCost, cmd.kind === 'REVERSAL' && amount < 0n)
    )
    await this.outbox.append(scope, {
      aggregateType: 'stock_movement',
      aggregateId: movement.id,
      aggregateVersion: 1,
      eventType: 'inventory.stock.moved',
      payload: {
        movementId: movement.id,
        kind: cmd.kind,
        variantId: cmd.variantId,
        locationId: cmd.locationId,
        lotId: cmd.lotId,
        quantityDelta: movement.quantityDelta,
        sourceType: cmd.source.type,
        sourceId: cmd.source.id,
      },
      correlationId: context.correlationId,
    })
    return { movement, idempotent: false }
  }

  // --- reservas ------------------------------------------------------------------------------

  reserve(
    context: TenantContext,
    input: ReserveInput
  ): Promise<{ reservation: Reservation; idempotent: boolean }> {
    return this.uow.run((scope) => this.reserveInScope(scope, input), context)
  }

  /**
   * Reserva `quantity` num local/lote; falha se o disponível (`em mão − reservado`) não chegar. Repetir a mesma origem
   * (documento, linha, local, lote) devolve a reserva existente.
   */
  async reserveInScope(
    scope: TenantScope,
    input: ReserveInput
  ): Promise<{ reservation: Reservation; idempotent: boolean }> {
    const quantity = parseQty(input.quantity)
    const issues: Issue[] = sourceIssues({ sourceType: input.source.type })
    if (quantity === null || quantity === 0n) {
      issues.push({
        path: 'quantity',
        code: 'INVALID_QUANTITY',
        message: 'Quantidade positiva com até 6 casas.',
      })
    }
    if (input.expiresAt && input.expiresAt.getTime() <= this.clock.now().getTime()) {
      issues.push({
        path: 'expiresAt',
        code: 'EXPIRES_IN_PAST',
        message: 'A validade tem de ser futura.',
      })
    }
    if (issues.length > 0) throw inventoryValidation(issues)
    const amount = quantity as bigint
    const key = {
      sourceType: input.source.type,
      sourceId: input.source.id,
      sourceLineId: input.source.lineId ?? null,
      locationId: input.locationId,
      lotId: input.lotId ?? null,
    }
    const existing = await this.reservations.findByKey(scope, key)
    if (existing) {
      if (existing.variantId !== input.variantId || fromDb(existing.quantity, 6) !== amount) {
        throw ApiError.conflict(
          'SOURCE_CONFLICT',
          'Esta origem já reservou uma quantidade diferente.'
        )
      }
      return { reservation: existing, idempotent: true }
    }
    const location = await this.warehouses.findLocation(scope, input.locationId)
    if (!location) throw fail('locationId', 'UNKNOWN_LOCATION', 'O local não existe.')
    if (!location.active || !location.warehouseActive) {
      throw ApiError.conflict('LOCATION_INACTIVE', 'O local ou o armazém está desactivado.')
    }
    const variant = await this.requireStocked(scope.context, input.variantId)
    await this.requirePrecision(scope.context, variant, amount)
    await this.requireLot(scope, variant, input.lotId ?? null, true)

    const balance = await this.ledger.lockBalance(scope, {
      variantId: input.variantId,
      locationId: input.locationId,
      lotId: input.lotId ?? null,
    })
    const available = fromDb(balance.onHand, 6) - fromDb(balance.reserved, 6)
    if (available < amount) {
      throw new ApiError(409, 'INSUFFICIENT_STOCK', 'Stock disponível insuficiente.', [
        {
          path: 'quantity',
          code: 'INSUFFICIENT_STOCK',
          message: `Disponível: ${qtyText(available < 0n ? 0n : available)}.`,
        },
      ])
    }
    const reservation = await this.applyReservation(scope, balance, amount, {
      organizationId: location.organizationId,
      variantId: input.variantId,
      locationId: input.locationId,
      lotId: input.lotId ?? null,
      sourceType: input.source.type,
      sourceId: input.source.id,
      sourceLineId: input.source.lineId ?? null,
      expiresAt: input.expiresAt ?? null,
    })
    return { reservation, idempotent: false }
  }

  /** Cria a reserva e soma-a ao reservado do saldo (já bloqueado pelo chamador). */
  async applyReservation(
    scope: TenantScope,
    balance: BalanceRow,
    amount: bigint,
    values: {
      organizationId: string
      variantId: string
      locationId: string
      lotId: string | null
      sourceType: string
      sourceId: string
      sourceLineId: string | null
      expiresAt: Date | null
    }
  ): Promise<Reservation> {
    const reservation = await this.reservations.insert(scope, {
      ...values,
      quantity: qtyText(amount),
    })
    await this.ledger.saveBalance(
      scope,
      balance.id,
      balance.onHand,
      qtyText(fromDb(balance.reserved, 6) + amount)
    )
    return reservation
  }

  /** Liberta o que resta (ou `quantity`) de uma reserva. Libertar duas vezes é inofensivo. */
  release(
    context: TenantContext,
    id: string,
    quantity?: string
  ): Promise<{ reservation: Reservation; idempotent: boolean }> {
    return this.uow.run(async (scope) => {
      const reservation = await this.reservations.find(scope, id, true)
      if (!reservation) throw ApiError.notFound()
      if (reservation.status !== 'ACTIVE') return { reservation, idempotent: true }
      const remaining = remainingOf(reservation)
      let part = remaining
      if (quantity !== undefined) {
        const parsed = parseQty(quantity)
        if (parsed === null || parsed === 0n || parsed > remaining) {
          throw fail('quantity', 'INVALID_QUANTITY', `Quantidade entre 0 e ${qtyText(remaining)}.`)
        }
        part = parsed
      }
      return {
        reservation: await this.releaseInScope(scope, reservation, part, false),
        idempotent: false,
      }
    }, context)
  }

  /** Liberta `part` de uma reserva já bloqueada: baixa o reservado do saldo e fecha a reserva se nada resta. */
  async releaseInScope(
    scope: TenantScope,
    reservation: Reservation,
    part: bigint,
    expired: boolean
  ): Promise<Reservation> {
    const balance = await this.ledger.lockBalance(scope, {
      variantId: reservation.variantId,
      locationId: reservation.locationId,
      lotId: reservation.lotId,
    })
    const reserved = fromDb(balance.reserved, 6) - part
    await this.ledger.saveBalance(
      scope,
      balance.id,
      balance.onHand,
      qtyText(reserved < 0n ? 0n : reserved)
    )
    const quantity = fromDb(reservation.quantity, 6)
    const consumed = fromDb(reservation.consumedQty, 6)
    const released = fromDb(reservation.releasedQty, 6) + part
    return this.reservations.update(scope, reservation.id, {
      consumedQty: qtyText(consumed),
      releasedQty: qtyText(released),
      status: reservationStatus(quantity, consumed, released, expired),
    })
  }

  /** Liberta as reservas vencidas (`expires_at` passou). Devolve quantas fechou. */
  expireDue(context: TenantContext, limit = 200): Promise<number> {
    return this.uow.run(async (scope) => {
      const due = await this.reservations.lockExpired(scope, this.clock.now(), limit)
      for (const reservation of due) {
        await this.releaseInScope(scope, reservation, remainingOf(reservation), true)
      }
      return due.length
    }, context)
  }

  private async consumeReservation(
    scope: TenantScope,
    cmd: PostCommand,
    quantity: bigint
  ): Promise<bigint> {
    const reservation = await this.reservations.find(scope, cmd.reservationId as string, true)
    if (!reservation) throw fail('reservationId', 'UNKNOWN_RESERVATION', 'A reserva não existe.')
    if (
      reservation.variantId !== cmd.variantId ||
      reservation.locationId !== cmd.locationId ||
      reservation.lotId !== cmd.lotId
    ) {
      throw ApiError.conflict(
        'RESERVATION_MISMATCH',
        'A reserva é de outra variante, local ou lote.'
      )
    }
    const remaining = remainingOf(reservation)
    if (reservation.status !== 'ACTIVE' || remaining < quantity) {
      throw ApiError.conflict(
        'RESERVATION_INSUFFICIENT',
        `A reserva só tem ${qtyText(remaining)} por consumir.`
      )
    }
    const quantityTotal = fromDb(reservation.quantity, 6)
    const consumed = fromDb(reservation.consumedQty, 6) + quantity
    const released = fromDb(reservation.releasedQty, 6)
    await this.reservations.update(scope, reservation.id, {
      consumedQty: qtyText(consumed),
      releasedQty: qtyText(released),
      status: reservationStatus(quantityTotal, consumed, released, false),
    })
    return quantity
  }

  // --- validações partilhadas ----------------------------------------------------------------

  private async requireStocked(context: TenantContext, variantId: string): Promise<VariantRef> {
    const variant = await this.references.variant(context, variantId)
    if (!variant) throw fail('variantId', 'UNKNOWN_VARIANT', 'A variante não existe.')
    if (!variant.product.trackStock) {
      throw ApiError.conflict('NOT_STOCK_TRACKED', 'Este produto não tem controlo de stock.')
    }
    if (variant.product.trackingMode === 'SERIAL') {
      throw ApiError.conflict(
        'SERIAL_NOT_SUPPORTED',
        'O rastreio por número de série ainda não está disponível.'
      )
    }
    return variant
  }

  private async requirePrecision(context: TenantContext, variant: VariantRef, quantity: bigint) {
    const precision = await this.references.unitPrecision(context, variant.product.baseUnitId)
    if (precision === null)
      throw fail('variantId', 'UNKNOWN_UNIT', 'A unidade do produto não existe.')
    // A quantidade está em micro-unidades: as casas usadas são as que sobram depois de tirar zeros à direita.
    const text = qtyText(quantity).split('.')[1] ?? ''
    const used = text.replace(/0+$/, '').length
    if (used > precision) {
      throw fail(
        'quantity',
        'QUANTITY_PRECISION',
        `A unidade do produto admite até ${precision} casas decimais.`
      )
    }
  }

  private async requireLot(
    scope: TenantScope,
    variant: VariantRef,
    lotId: string | null,
    blockExpired: boolean
  ) {
    if (variant.product.trackingMode === 'NONE') {
      if (lotId) throw fail('lotId', 'LOT_NOT_ALLOWED', 'Este produto não tem rastreio por lote.')
      return
    }
    if (!lotId) throw fail('lotId', 'LOT_REQUIRED', 'Indique o lote.')
    const lot = await this.lots.find(scope, lotId)
    if (!lot || lot.variantId !== variant.id) {
      throw fail('lotId', 'UNKNOWN_LOT', 'O lote não existe para esta variante.')
    }
    const today = this.clock.now().toISOString().slice(0, 10)
    if (blockExpired && lot.expiresOn && lot.expiresOn < today) {
      throw ApiError.conflict('LOT_EXPIRED', `O lote ${lot.code} expirou em ${lot.expiresOn}.`)
    }
  }
}

export const remainingOf = (r: Reservation): bigint =>
  fromDb(r.quantity, 6) - fromDb(r.consumedQty, 6) - fromDb(r.releasedQty, 6)

export type { BalanceView }
