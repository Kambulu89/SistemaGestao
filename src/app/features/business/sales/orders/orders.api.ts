import { inject, Injectable } from '@angular/core';
import { map, switchMap, type Observable, throwError, of } from 'rxjs';
import { ApiService } from '../../../../core/api/api.service';
import { CatalogApi } from '../catalog/catalog.api';

export type QuoteStatus = 'DRAFT' | 'SENT' | 'ACCEPTED' | 'REJECTED' | 'EXPIRED';
export type OrderStatus = 'DRAFT' | 'CONFIRMED' | 'PARTIAL' | 'FULFILLED' | 'CANCELLED';

export interface Totals {
  readonly net: string;
  readonly tax: string;
  readonly total: string;
}

export interface PriceOrigin {
  readonly priceListName: string;
  readonly priority: number;
  readonly minQuantity: string;
  readonly maxDiscount: string;
  readonly taxInclusive: boolean;
}

export interface LineDto {
  readonly id: string;
  readonly position: number;
  readonly variantId: string;
  readonly descriptionSnapshot: string;
  /** Decimais como texto: nunca `number`. */
  readonly quantity: string;
  readonly unitPrice: string;
  readonly discountRate: string;
  readonly taxRateSnapshot: string;
  readonly netAmount: string;
  readonly taxAmount: string;
  readonly total: string;
  /** Quantidade já expedida (só na leitura da encomenda): soma das expedições lançadas e não revertidas. */
  readonly shippedQty?: string;
  readonly priceOrigin: PriceOrigin;
}

export interface QuoteDto {
  readonly id: string;
  readonly organizationId: string;
  readonly customerId: string;
  readonly number: string | null;
  readonly validUntil: string;
  readonly currency: string;
  readonly status: QuoteStatus;
  readonly notes: string | null;
  readonly totals: Totals;
  readonly version: number;
  readonly lines?: readonly LineDto[];
}

export interface OrderDto {
  readonly id: string;
  readonly organizationId: string;
  readonly customerId: string;
  readonly quoteId: string | null;
  readonly number: string | null;
  readonly orderDate: string;
  readonly currency: string;
  readonly status: OrderStatus;
  readonly deliveryAddress: Readonly<Record<string, string>> | null;
  readonly creditReservation: string;
  readonly totals: Totals;
  readonly confirmedAt: string | null;
  readonly cancelledAt: string | null;
  readonly cancelReason: string | null;
  readonly version: number;
  readonly lines?: readonly LineDto[];
}

export type ShipmentStatus = 'DRAFT' | 'POSTED' | 'REVERSED';

export interface ShipmentLineDto {
  readonly id: string;
  readonly shipmentId: string;
  readonly orderLineId: string;
  /** Decimal como texto. */
  readonly quantity: string;
  readonly version: number;
}

export interface ShipmentDto {
  readonly id: string;
  readonly orderId: string;
  readonly number: string | null;
  readonly status: ShipmentStatus;
  readonly notes: string | null;
  readonly shippedAt: string | null;
  readonly reversedAt: string | null;
  readonly reverseReason: string | null;
  readonly version: number;
  readonly lines?: readonly ShipmentLineDto[];
}

export interface DocumentFilter {
  readonly q?: string;
  readonly status?: string;
  readonly customerId?: string;
  readonly limit?: number;
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly total: number;
}

export interface NewLine {
  readonly variantId: string;
  readonly quantity: string;
  readonly discountRate?: string;
}

export interface CustomerOption {
  readonly id: string;
  readonly organizationId: string;
  readonly code: string;
  readonly partyName: string;
  readonly currency: string;
}

/** Propostas e encomendas (M04) sobre a API real: o servidor calcula preços, impostos e totais. */
@Injectable({ providedIn: 'root' })
export class OrdersApi {
  private readonly api = inject(ApiService);
  private readonly catalog = inject(CatalogApi);

  private params(filter: DocumentFilter): Record<string, string | number> {
    const params: Record<string, string | number> = {};
    for (const [key, value] of Object.entries(filter)) {
      if (value !== undefined && value !== '') params[key] = value;
    }
    return params;
  }

  private page<T>(path: string, filter: DocumentFilter): Observable<Page<T>> {
    return this.api
      .getWithMeta<readonly T[]>(path, { params: this.params(filter) })
      .pipe(map((r) => ({ items: r.data, total: Number(r.meta['total'] ?? r.data.length) })));
  }

  quotes(filter: DocumentFilter): Observable<Page<QuoteDto>> {
    return this.page('quotes', filter);
  }

  quote(id: string): Observable<QuoteDto> {
    return this.api.get(`quotes/${id}`);
  }

  createQuote(body: {
    organizationId: string;
    customerId: string;
    validUntil: string;
    notes?: string | null;
  }): Observable<QuoteDto> {
    return this.api.post('quotes', body);
  }

  addQuoteLine(id: string, line: NewLine): Observable<QuoteDto> {
    return this.api.post(`quotes/${id}/lines`, line);
  }

  removeQuoteLine(id: string, lineId: string): Observable<QuoteDto> {
    return this.api.delete(`quotes/${id}/lines/${lineId}`);
  }

  sendQuote(id: string): Observable<QuoteDto> {
    return this.api.post(`quotes/${id}/send`, {});
  }

  rejectQuote(id: string): Observable<QuoteDto> {
    return this.api.post(`quotes/${id}/reject`, {});
  }

  acceptQuote(id: string): Observable<{ quote: QuoteDto; order: OrderDto; idempotent: boolean }> {
    return this.api.post(`quotes/${id}/accept`, {});
  }

  orders(filter: DocumentFilter): Observable<Page<OrderDto>> {
    return this.page('sales-orders', filter);
  }

  order(id: string): Observable<OrderDto> {
    return this.api.get(`sales-orders/${id}`);
  }

  createOrder(body: {
    organizationId: string;
    customerId: string;
    deliveryAddress?: Record<string, string>;
  }): Observable<OrderDto> {
    return this.api.post('sales-orders', body);
  }

  updateOrder(
    id: string,
    expectedVersion: number,
    body: { deliveryAddress: Record<string, string> | null },
  ): Observable<OrderDto> {
    return this.api.patch(`sales-orders/${id}`, { expectedVersion, ...body });
  }

  addOrderLine(id: string, line: NewLine): Observable<OrderDto> {
    return this.api.post(`sales-orders/${id}/lines`, line);
  }

  removeOrderLine(id: string, lineId: string): Observable<OrderDto> {
    return this.api.delete(`sales-orders/${id}/lines/${lineId}`);
  }

  confirmOrder(id: string): Observable<{ order: OrderDto; idempotent: boolean }> {
    return this.api.post(`sales-orders/${id}/confirm`, {});
  }

  cancelOrder(id: string, reason: string): Observable<{ order: OrderDto; idempotent: boolean }> {
    return this.api.post(`sales-orders/${id}/cancel`, { reason });
  }

  shipments(filter: {
    orderId?: string;
    status?: ShipmentStatus;
    limit?: number;
  }): Observable<Page<ShipmentDto>> {
    return this.page('shipments', filter as DocumentFilter);
  }

  shipment(id: string): Observable<ShipmentDto> {
    return this.api.get(`shipments/${id}`);
  }

  createShipment(body: {
    orderId: string;
    lines: readonly { orderLineId: string; quantity: string }[];
  }): Observable<ShipmentDto> {
    return this.api.post('shipments', body);
  }

  updateShipmentLine(id: string, lineId: string, quantity: string): Observable<ShipmentDto> {
    return this.api.patch(`shipments/${id}/lines/${lineId}`, { quantity });
  }

  removeShipmentLine(id: string, lineId: string): Observable<ShipmentDto> {
    return this.api.delete(`shipments/${id}/lines/${lineId}`);
  }

  deleteShipment(id: string): Observable<void> {
    return this.api.delete(`shipments/${id}`);
  }

  postShipment(id: string): Observable<{ shipment: ShipmentDto; idempotent: boolean }> {
    return this.api.post(`shipments/${id}/post`, {});
  }

  reverseShipment(
    id: string,
    reason: string,
  ): Observable<{ shipment: ShipmentDto; idempotent: boolean }> {
    return this.api.post(`shipments/${id}/reverse`, { reason });
  }

  /** Clientes para escolher no documento (exige `customer.read`; sem ele a lista vem vazia e o formulário avisa). */
  customers(): Observable<readonly CustomerOption[]> {
    return this.api
      .get<readonly CustomerOption[]>('customers', { params: { status: 'ACTIVE', limit: 200 } })
      .pipe(map((list) => list));
  }

  /** O utilizador conhece o SKU; a API pede o id da variante. */
  variantIdBySku(sku: string): Observable<string> {
    return this.catalog.products({ q: sku, limit: 20 }).pipe(
      switchMap((page) => {
        const hit = page.items.find((p) => p.code === sku) ?? page.items[0];
        return hit ? this.catalog.product(hit.id) : of(null);
      }),
      switchMap((product) => {
        const variant = product?.variants?.find((v) => v.sku === sku);
        return variant
          ? of(variant.id)
          : throwError(() => ({ status: 404, message: `Nenhuma variante com o SKU «${sku}».` }));
      }),
    );
  }
}
