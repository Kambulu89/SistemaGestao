import { inject, Injectable } from '@angular/core';
import { map, type Observable } from 'rxjs';
import { ApiService } from '../../../../core/api/api.service';
import type { Page } from '../stock/inventory.api';

export type TransferStatus = 'DRAFT' | 'DISPATCHED' | 'PARTIAL_RECEIVED' | 'RECEIVED' | 'CANCELLED';
export type CountStatus = 'DRAFT' | 'OPEN' | 'REVIEW' | 'POSTED' | 'CANCELLED';
export type ReturnDirection = 'CUSTOMER' | 'SUPPLIER';
export type ReturnStatus = 'DRAFT' | 'APPROVED' | 'POSTED';
export type ReturnCondition = 'SELLABLE' | 'DAMAGED' | 'QUARANTINE';

/** Quantidades como texto decimal: nunca `number`. */
export interface TransferLineDto {
  readonly id: string;
  readonly position: number;
  readonly variantId: string;
  readonly lotId: string | null;
  readonly quantity: string;
  readonly dispatchedQty: string;
  readonly receivedQty: string;
  readonly inTransit: string;
}

export interface TransferDto {
  readonly id: string;
  readonly organizationId: string;
  readonly number: string | null;
  readonly sourceWarehouseId: string;
  readonly destinationWarehouseId: string;
  readonly status: TransferStatus;
  readonly notes: string | null;
  readonly cancelReason: string | null;
  readonly version: number;
  readonly lines?: readonly TransferLineDto[];
  readonly receipts?: readonly { readonly id: string; readonly receivedAt: string }[];
}

export interface CountLineDto {
  readonly id: string;
  readonly variantId: string;
  readonly locationId: string;
  readonly lotId: string | null;
  /** `null` na contagem cega enquanto se conta. */
  readonly expectedQty: string | null;
  readonly countedQty: string | null;
  readonly varianceQty: string | null;
  readonly reason: string | null;
}

export interface CountDto {
  readonly id: string;
  readonly organizationId: string;
  readonly warehouseId: string;
  readonly number: string | null;
  readonly status: CountStatus;
  readonly blind: boolean;
  readonly notes: string | null;
  readonly version: number;
  readonly lines?: readonly CountLineDto[];
}

export interface ReturnLineDto {
  readonly id: string;
  readonly sourceLineId: string;
  readonly variantId: string;
  readonly quantity: string;
  readonly condition: ReturnCondition;
}

export interface ReturnDto {
  readonly id: string;
  readonly organizationId: string;
  readonly number: string | null;
  readonly direction: ReturnDirection;
  readonly sourceDocumentId: string;
  readonly warehouseId: string;
  readonly reason: string;
  readonly status: ReturnStatus;
  readonly version: number;
  readonly lines?: readonly ReturnLineDto[];
}

export interface SourceLineDto {
  readonly sourceLineId: string;
  readonly variantId: string;
  readonly quantity: string;
  readonly returned: string;
  readonly returnable: string;
  readonly unitCost: string;
}

export interface SourceDocumentDto {
  readonly id: string;
  readonly number: string | null;
}

export interface NewTransferLine {
  readonly variantId: string;
  readonly quantity: string;
}

const clean = (params: Record<string, unknown>): Record<string, string | number> =>
  Object.fromEntries(
    Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== ''),
  ) as Record<string, string | number>;

/** Logística de stock (M08) sobre a API real: o servidor move o stock; aqui só se pede e se mostra. */
@Injectable({ providedIn: 'root' })
export class LogisticsApi {
  private readonly api = inject(ApiService);

  private page<T>(path: string, params: Record<string, unknown>) {
    return this.api
      .getWithMeta<readonly T[]>(path, { params: clean(params) })
      .pipe(
        map((r): Page<T> => ({ items: r.data, total: Number(r.meta['total'] ?? r.data.length) })),
      );
  }

  // --- transferências ---------------------------------------------------------------------------

  transfers(filter: { status?: TransferStatus; limit?: number }) {
    return this.page<TransferDto>('stock-transfers', filter);
  }

  transfer(id: string): Observable<TransferDto> {
    return this.api.get(`stock-transfers/${id}`);
  }

  createTransfer(body: {
    sourceWarehouseId: string;
    destinationWarehouseId: string;
    notes?: string | null;
    lines: readonly NewTransferLine[];
  }): Observable<TransferDto> {
    return this.api.post('stock-transfers', body);
  }

  removeTransferLine(id: string, lineId: string): Observable<TransferDto> {
    return this.api.delete(`stock-transfers/${id}/lines/${lineId}`);
  }

  deleteTransfer(id: string): Observable<void> {
    return this.api.delete(`stock-transfers/${id}`);
  }

  dispatchTransfer(id: string): Observable<TransferDto> {
    return this.api.post(`stock-transfers/${id}/dispatch`, {});
  }

  receiveTransfer(
    id: string,
    lines: readonly { lineId: string; quantity: string }[],
  ): Observable<TransferDto> {
    return this.api.post(`stock-transfers/${id}/receive`, { lines });
  }

  cancelTransfer(id: string, reason: string): Observable<TransferDto> {
    return this.api.post(`stock-transfers/${id}/cancel`, { reason });
  }

  // --- contagens --------------------------------------------------------------------------------

  counts(filter: { status?: CountStatus; limit?: number }) {
    return this.page<CountDto>('stock-counts', filter);
  }

  count(id: string): Observable<CountDto> {
    return this.api.get(`stock-counts/${id}`);
  }

  createCount(body: { warehouseId: string; blind: boolean }): Observable<CountDto> {
    return this.api.post('stock-counts', body);
  }

  deleteCount(id: string): Observable<void> {
    return this.api.delete(`stock-counts/${id}`);
  }

  openCount(id: string): Observable<CountDto> {
    return this.api.post(`stock-counts/${id}/open`, {});
  }

  countLines(
    id: string,
    lines: readonly { lineId: string; countedQty: string; reason?: string | null }[],
  ): Observable<CountDto> {
    return this.api.put(`stock-counts/${id}/counts`, { lines });
  }

  reviewCount(id: string): Observable<CountDto> {
    return this.api.post(`stock-counts/${id}/review`, {});
  }

  reopenCount(id: string): Observable<CountDto> {
    return this.api.post(`stock-counts/${id}/reopen`, {});
  }

  postCount(id: string): Observable<CountDto> {
    return this.api.post(`stock-counts/${id}/post`, {});
  }

  cancelCount(id: string, reason: string): Observable<CountDto> {
    return this.api.post(`stock-counts/${id}/cancel`, { reason });
  }

  // --- devoluções -------------------------------------------------------------------------------

  returns(filter: { direction?: ReturnDirection; status?: ReturnStatus; limit?: number }) {
    return this.page<ReturnDto>('goods-returns', filter);
  }

  return(id: string): Observable<ReturnDto> {
    return this.api.get(`goods-returns/${id}`);
  }

  returnSourceLines(
    direction: ReturnDirection,
    sourceDocumentId: string,
  ): Observable<readonly SourceLineDto[]> {
    return this.api.get('goods-returns/source-lines', { params: { direction, sourceDocumentId } });
  }

  /** Documentos de origem possíveis: expedições (cliente) ou recepções (fornecedor) já lançadas. */
  sourceDocuments(direction: ReturnDirection): Observable<readonly SourceDocumentDto[]> {
    const path = direction === 'CUSTOMER' ? 'shipments' : 'goods-receipts';
    return this.api.get(path, { params: { status: 'POSTED', limit: 100 } });
  }

  createReturn(body: {
    direction: ReturnDirection;
    sourceDocumentId: string;
    warehouseId: string;
    reason: string;
    lines: readonly { sourceLineId: string; quantity: string; condition: ReturnCondition }[];
  }): Observable<ReturnDto> {
    return this.api.post('goods-returns', body);
  }

  deleteReturn(id: string): Observable<void> {
    return this.api.delete(`goods-returns/${id}`);
  }

  approveReturn(id: string): Observable<ReturnDto> {
    return this.api.post(`goods-returns/${id}/approve`, {});
  }

  postReturn(id: string): Observable<ReturnDto> {
    return this.api.post(`goods-returns/${id}/post`, {});
  }
}
