import { inject, Injectable } from '@angular/core';
import { map, of, switchMap, throwError, type Observable } from 'rxjs';
import { ApiService } from '../../../../core/api/api.service';
import { CatalogApi, type TrackingMode } from '../../sales/catalog/catalog.api';

export type MovementKind =
  'RECEIPT' | 'ISSUE' | 'ADJUSTMENT' | 'TRANSFER_IN' | 'TRANSFER_OUT' | 'REVERSAL';
export type ReservationStatus = 'ACTIVE' | 'CONSUMED' | 'RELEASED' | 'EXPIRED';

export interface WarehouseDto {
  readonly id: string;
  readonly organizationId: string;
  readonly code: string;
  readonly name: string;
  readonly allowNegative: boolean;
  readonly allowBackorder: boolean;
  readonly salesDefault: boolean;
  readonly active: boolean;
  readonly version: number;
  readonly locations?: readonly LocationDto[];
}

export interface LocationDto {
  readonly id: string;
  readonly warehouseId: string;
  readonly code: string;
  readonly name: string;
  readonly active: boolean;
  readonly version: number;
}

export interface LotDto {
  readonly id: string;
  readonly variantId: string;
  readonly code: string;
  readonly manufacturedOn: string | null;
  readonly expiresOn: string | null;
}

/** Quantidades como texto decimal: nunca `number`. */
export interface BalanceDto {
  readonly id: string;
  readonly variantId: string;
  readonly locationId: string;
  readonly warehouseId: string;
  readonly lotId: string | null;
  readonly lotCode: string | null;
  readonly expiresOn: string | null;
  readonly onHand: string;
  readonly reserved: string;
  readonly available: string;
}

export interface MovementDto {
  readonly id: string;
  readonly variantId: string;
  readonly locationId: string;
  readonly lotId: string | null;
  readonly quantityDelta: string;
  readonly unitCost: string;
  readonly sourceType: string;
  readonly sourceId: string;
  readonly kind: MovementKind;
  readonly reversedMovementId: string | null;
  readonly reason: string | null;
  readonly postedAt: string;
}

export interface ReservationDto {
  readonly id: string;
  readonly variantId: string;
  readonly locationId: string;
  readonly lotId: string | null;
  readonly sourceType: string;
  readonly sourceId: string;
  readonly quantity: string;
  readonly consumedQty: string;
  readonly releasedQty: string;
  readonly expiresAt: string | null;
  readonly status: ReservationStatus;
}

export interface VariantInfo {
  readonly id: string;
  readonly sku: string;
  readonly productName: string;
  readonly trackStock: boolean;
  readonly trackingMode: TrackingMode;
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly total: number;
}

export interface BalanceFilter {
  readonly variantId?: string;
  readonly warehouseId?: string;
  readonly nonZero?: boolean;
  readonly limit: number;
  readonly offset: number;
}

export interface AdjustmentBody {
  readonly variantId: string;
  readonly locationId: string;
  readonly lotId?: string | null;
  readonly quantityDelta: string;
  readonly unitCost?: string | null;
  readonly reason: string;
  readonly reference: string;
}

interface VariantResponse {
  readonly id: string;
  readonly sku: string;
  readonly product: {
    readonly name: string;
    readonly trackStock: boolean;
    readonly trackingMode: TrackingMode;
  };
}

const clean = (params: Record<string, unknown>): Record<string, string | number | boolean> =>
  Object.fromEntries(
    Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== ''),
  ) as Record<string, string | number | boolean>;

/** Inventário (M07) sobre a API real: o servidor é dono dos saldos, do livro e das reservas. */
@Injectable({ providedIn: 'root' })
export class InventoryApi {
  private readonly api = inject(ApiService);
  private readonly catalog = inject(CatalogApi);

  warehouses(): Observable<readonly WarehouseDto[]> {
    return this.api.get('warehouses');
  }

  warehouse(id: string): Observable<WarehouseDto> {
    return this.api.get(`warehouses/${id}`);
  }

  createWarehouse(body: {
    organizationId: string;
    code: string;
    name: string;
    allowNegative: boolean;
    allowBackorder: boolean;
  }): Observable<WarehouseDto> {
    return this.api.post('warehouses', body);
  }

  updateWarehouse(
    warehouse: Pick<WarehouseDto, 'id' | 'version'>,
    changes: Partial<
      Pick<WarehouseDto, 'name' | 'allowNegative' | 'allowBackorder' | 'salesDefault' | 'active'>
    >,
  ): Observable<WarehouseDto> {
    return this.api.patch(`warehouses/${warehouse.id}`, {
      expectedVersion: warehouse.version,
      ...changes,
    });
  }

  createLocation(
    warehouseId: string,
    body: { code: string; name: string },
  ): Observable<LocationDto> {
    return this.api.post(`warehouses/${warehouseId}/locations`, body);
  }

  updateLocation(
    location: Pick<LocationDto, 'id' | 'version'>,
    changes: { name?: string; active?: boolean },
  ): Observable<LocationDto> {
    return this.api.patch(`stock-locations/${location.id}`, {
      expectedVersion: location.version,
      ...changes,
    });
  }

  lots(variantId?: string): Observable<readonly LotDto[]> {
    return this.api.get('lots', { params: clean({ variantId }) });
  }

  createLot(body: {
    variantId: string;
    code: string;
    manufacturedOn: string | null;
    expiresOn: string | null;
  }): Observable<LotDto> {
    return this.api.post('lots', body);
  }

  balances(filter: BalanceFilter): Observable<Page<BalanceDto>> {
    return this.api
      .getWithMeta<readonly BalanceDto[]>('stock-balances', { params: clean({ ...filter }) })
      .pipe(
        map((r) => ({
          items: r.data,
          total: (r.meta as { total?: number }).total ?? r.data.length,
        })),
      );
  }

  movements(filter: {
    variantId?: string;
    locationId?: string;
    limit: number;
    offset: number;
  }): Observable<Page<MovementDto>> {
    return this.api
      .getWithMeta<readonly MovementDto[]>('stock-movements', { params: clean({ ...filter }) })
      .pipe(
        map((r) => ({
          items: r.data,
          total: (r.meta as { total?: number }).total ?? r.data.length,
        })),
      );
  }

  adjust(body: AdjustmentBody): Observable<MovementDto & { idempotent: boolean }> {
    return this.api.post('stock-adjustments', body);
  }

  reverse(id: string, reason: string): Observable<MovementDto & { idempotent: boolean }> {
    return this.api.post(`stock-movements/${id}/reverse`, { reason });
  }

  reservations(filter: {
    status?: ReservationStatus;
    variantId?: string;
    limit: number;
    offset: number;
  }): Observable<Page<ReservationDto>> {
    return this.api
      .getWithMeta<readonly ReservationDto[]>('stock-reservations', {
        params: clean({ ...filter }),
      })
      .pipe(
        map((r) => ({
          items: r.data,
          total: (r.meta as { total?: number }).total ?? r.data.length,
        })),
      );
  }

  release(id: string): Observable<ReservationDto> {
    return this.api.post(`stock-reservations/${id}/release`, {});
  }

  expireReservations(): Observable<{ expired: number }> {
    return this.api.post('stock-reservations/expire', {});
  }

  /** Uma variante pelo id (para mostrar o SKU e o produto); precisa de `catalog.read`. */
  variant(id: string): Observable<VariantInfo> {
    return this.api.get<VariantResponse>(`variants/${id}`).pipe(map(toInfo));
  }

  /** Resolve um SKU na variante exacta (o servidor pesquisa por produto). */
  variantBySku(sku: string): Observable<VariantInfo> {
    const wanted = sku.trim();
    return this.catalog.products({ q: wanted, limit: 20 }).pipe(
      switchMap((page) => {
        const hit = page.items.find((p) => p.code === wanted) ?? page.items[0];
        return hit ? this.catalog.product(hit.id) : of(null);
      }),
      switchMap((product) => {
        const variant = product?.variants?.find((v) => v.sku === wanted);
        return product && variant
          ? of<VariantInfo>({
              id: variant.id,
              sku: variant.sku,
              productName: product.name,
              trackStock: product.trackStock,
              trackingMode: product.trackingMode,
            })
          : throwError(() => ({ status: 404, message: `Nenhuma variante com o SKU «${wanted}».` }));
      }),
    );
  }
}

const toInfo = (v: VariantResponse): VariantInfo => ({
  id: v.id,
  sku: v.sku,
  productName: v.product.name,
  trackStock: v.product.trackStock,
  trackingMode: v.product.trackingMode,
});
