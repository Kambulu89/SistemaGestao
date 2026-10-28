import { ApiError } from '#core/http/api_error'
import type { TenantContext, TenantUnitOfWork } from '#core/tenancy/index'
import {
  locationIssues,
  lotIssues,
  warehouseIssues,
  type Issue,
} from '#modules/inventory/domain/stock'
import type {
  Location,
  Lot,
  LotStore,
  References,
  Warehouse,
  WarehouseStore,
} from '#modules/inventory/application/ports'

export const inventoryValidation = (details: Issue[]) =>
  new ApiError(422, 'VALIDATION_ERROR', 'Verifique os campos indicados.', details)

export interface WarehouseDetail extends Warehouse {
  locations: Location[]
}

/** Local criado com cada armazém, para que fique utilizável de imediato. */
const MAIN_LOCATION = { code: 'PRINCIPAL', name: 'Principal' }

/** Armazéns, locais e lotes (M07). Nada se apaga: desactiva-se. O saldo não se edita; só se move pelo livro. */
export class WarehouseUseCases {
  constructor(
    private readonly uow: TenantUnitOfWork,
    private readonly warehouses: WarehouseStore,
    private readonly lots: LotStore,
    private readonly references: References
  ) {}

  list(context: TenantContext, filter: { organizationId?: string }): Promise<Warehouse[]> {
    return this.uow.run((scope) => this.warehouses.list(scope, filter), context)
  }

  get(context: TenantContext, id: string): Promise<WarehouseDetail> {
    return this.uow.run(async (scope) => {
      const warehouse = await this.warehouses.find(scope, id)
      if (!warehouse) throw ApiError.notFound()
      return { ...warehouse, locations: await this.warehouses.listLocations(scope, id) }
    }, context)
  }

  async create(
    context: TenantContext,
    input: {
      organizationId: string
      code: string
      name: string
      allowNegative?: boolean
      allowBackorder?: boolean
    }
  ): Promise<WarehouseDetail> {
    const issues = warehouseIssues(input, true)
    if (issues.length > 0) throw inventoryValidation(issues)
    if (!(await this.references.organizationExists(context, input.organizationId))) {
      throw inventoryValidation([
        {
          path: 'organizationId',
          code: 'UNKNOWN_ORGANIZATION',
          message: 'A organização não existe.',
        },
      ])
    }
    return this.uow.run(async (scope) => {
      const created = await this.warehouses.insert(scope, {
        organizationId: input.organizationId,
        code: input.code.trim(),
        name: input.name.trim(),
        allowNegative: input.allowNegative,
        allowBackorder: input.allowBackorder,
      })
      if (!created) {
        throw ApiError.conflict('WAREHOUSE_CODE_TAKEN', 'Já existe um armazém com este código.')
      }
      const main = await this.warehouses.insertLocation(scope, created.id, MAIN_LOCATION)
      return { ...created, locations: main ? [main] : [] }
    }, context)
  }

  async update(
    context: TenantContext,
    id: string,
    input: {
      expectedVersion: number
      name?: string
      allowNegative?: boolean
      allowBackorder?: boolean
      salesDefault?: boolean
      active?: boolean
    }
  ): Promise<WarehouseDetail> {
    const issues = warehouseIssues({ name: input.name }, false)
    if (issues.length > 0) throw inventoryValidation(issues)
    return this.uow.run(async (scope) => {
      const current = await this.warehouses.find(scope, id)
      if (!current) throw ApiError.notFound()
      if (input.salesDefault === true && !(input.active ?? current.active)) {
        throw ApiError.conflict(
          'WAREHOUSE_INACTIVE',
          'Um armazém inactivo não pode ser o de vendas.'
        )
      }
      if (input.active === false && current.salesDefault && input.salesDefault !== false) {
        throw ApiError.conflict(
          'WAREHOUSE_SALES_DEFAULT',
          'Retire primeiro o armazém de vendas antes de o desactivar.'
        )
      }
      const updated = await this.warehouses.update(scope, id, input.expectedVersion, {
        name: input.name?.trim(),
        allowNegative: input.allowNegative,
        allowBackorder: input.allowBackorder,
        salesDefault: input.salesDefault,
        active: input.active,
      })
      if (updated === 'SALES_DEFAULT_TAKEN') {
        throw ApiError.conflict(
          'SALES_WAREHOUSE_TAKEN',
          'A organização já tem outro armazém de vendas: retire-lhe primeiro essa marca.'
        )
      }
      return { ...updated, locations: await this.warehouses.listLocations(scope, id) }
    }, context)
  }

  async createLocation(
    context: TenantContext,
    warehouseId: string,
    input: { code: string; name: string }
  ): Promise<Location> {
    const issues = locationIssues(input)
    if (issues.length > 0) throw inventoryValidation(issues)
    return this.uow.run(async (scope) => {
      const warehouse = await this.warehouses.find(scope, warehouseId)
      if (!warehouse) throw ApiError.notFound()
      const created = await this.warehouses.insertLocation(scope, warehouseId, {
        code: input.code.trim(),
        name: input.name.trim(),
      })
      if (!created) {
        throw ApiError.conflict(
          'LOCATION_CODE_TAKEN',
          'Já existe um local com este código no armazém.'
        )
      }
      return created
    }, context)
  }

  async updateLocation(
    context: TenantContext,
    id: string,
    input: { expectedVersion: number; name?: string; active?: boolean }
  ): Promise<Location> {
    const issues = warehouseIssues({ name: input.name }, false)
    if (issues.length > 0) throw inventoryValidation(issues)
    return this.uow.run(async (scope) => {
      const current = await this.warehouses.findLocationRow(scope, id)
      if (!current) throw ApiError.notFound()
      return this.warehouses.updateLocation(scope, id, input.expectedVersion, {
        name: input.name?.trim(),
        active: input.active,
      })
    }, context)
  }

  // --- lotes ---------------------------------------------------------------------------------

  listLots(context: TenantContext, filter: { variantId?: string }): Promise<Lot[]> {
    return this.uow.run((scope) => this.lots.list(scope, filter), context)
  }

  async createLot(
    context: TenantContext,
    input: {
      variantId: string
      code: string
      manufacturedOn?: string | null
      expiresOn?: string | null
    }
  ): Promise<Lot> {
    const issues = lotIssues(input)
    if (issues.length > 0) throw inventoryValidation(issues)
    const variant = await this.references.variant(context, input.variantId)
    if (!variant) {
      throw inventoryValidation([
        { path: 'variantId', code: 'UNKNOWN_VARIANT', message: 'A variante não existe.' },
      ])
    }
    if (!variant.product.trackStock || variant.product.trackingMode !== 'LOT') {
      throw ApiError.conflict('NOT_LOT_TRACKED', 'Só os produtos com rastreio por lote têm lotes.')
    }
    return this.uow.run(async (scope) => {
      const created = await this.lots.insert(scope, {
        variantId: input.variantId,
        code: input.code.trim(),
        manufacturedOn: input.manufacturedOn ?? null,
        expiresOn: input.expiresOn ?? null,
      })
      if (!created) {
        throw ApiError.conflict(
          'LOT_CODE_TAKEN',
          'Já existe um lote com este código para a variante.'
        )
      }
      return created
    }, context)
  }
}
