import { inject, Injectable } from '@angular/core';
import { map, type Observable } from 'rxjs';
import { ApiService } from '../../../../core/api/api.service';
import type { Page } from '../../sales/orders/orders.api';

export type SupplierStatus = 'ACTIVE' | 'BLOCKED' | 'INACTIVE';
export type RequisitionStatus = 'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'REJECTED' | 'CONVERTED';
export type PurchaseStatus = 'DRAFT' | 'ORDERED' | 'PARTIAL' | 'RECEIVED' | 'CANCELLED';
export type ReceiptStatus = 'DRAFT' | 'POSTED' | 'REVERSED';

export interface Totals {
  readonly net: string;
  readonly tax: string;
  readonly total: string;
}

export interface SupplierDto {
  readonly id: string;
  readonly partyId: string;
  readonly organizationId: string;
  readonly code: string;
  readonly paymentTermDays: number;
  readonly currency: string;
  readonly status: SupplierStatus;
  readonly statusReason: string | null;
  readonly partyName: string;
  readonly taxId: string | null;
  readonly version: number;
}

export interface RequisitionLineDto {
  readonly id: string;
  readonly position: number;
  readonly variantId: string;
  readonly description: string;
  /** Decimais como texto: nunca `number`. */
  readonly quantity: string;
}

export interface RequisitionDto {
  readonly id: string;
  readonly organizationId: string;
  readonly requestedByMembershipId: string;
  readonly number: string | null;
  readonly status: RequisitionStatus;
  readonly neededOn: string | null;
  readonly notes: string | null;
  readonly decisionReason: string | null;
  readonly purchaseOrderId: string | null;
  readonly version: number;
  readonly lines?: readonly RequisitionLineDto[];
}

export interface PurchaseLineDto {
  readonly id: string;
  readonly position: number;
  readonly variantId: string;
  readonly description: string;
  readonly quantity: string;
  readonly unitCost: string;
  readonly taxRate: string;
  readonly netAmount: string;
  readonly taxAmount: string;
  readonly total: string;
  /** Soma das recepções lançadas e não revertidas (só na leitura da encomenda). */
  readonly receivedQty?: string;
}

export interface PurchaseDto {
  readonly id: string;
  readonly organizationId: string;
  readonly supplierId: string;
  readonly requisitionId: string | null;
  readonly number: string | null;
  readonly orderDate: string;
  readonly currency: string;
  readonly status: PurchaseStatus;
  readonly notes: string | null;
  readonly totals: Totals;
  readonly cancelReason: string | null;
  readonly version: number;
  readonly lines?: readonly PurchaseLineDto[];
}

export interface ReceiptLineDto {
  readonly id: string;
  readonly purchaseLineId: string;
  readonly quantity: string;
  readonly lotCode: string | null;
  readonly expiresOn: string | null;
}

export interface ReceiptDto {
  readonly id: string;
  readonly purchaseOrderId: string;
  readonly warehouseId: string | null;
  readonly number: string | null;
  readonly status: ReceiptStatus;
  readonly supplierDocument: string | null;
  readonly receivedAt: string | null;
  readonly reverseReason: string | null;
  readonly version: number;
  readonly lines?: readonly ReceiptLineDto[];
}

export interface PartyOption {
  readonly id: string;
  readonly displayName: string;
}

export interface OrganizationOption {
  readonly id: string;
  readonly code: string;
  readonly legalName: string;
}

export interface WarehouseOption {
  readonly id: string;
  readonly organizationId: string;
  readonly code: string;
  readonly name: string;
}

export interface NewPurchaseLine {
  readonly variantId: string;
  readonly quantity: string;
  readonly unitCost: string;
  readonly taxRate?: string;
}

export interface NewReceiptLine {
  readonly purchaseLineId: string;
  readonly quantity: string;
  readonly lotCode?: string;
  readonly expiresOn?: string;
}

/** Compras (M06) sobre a API real: o servidor calcula, numera e dá entrada do stock. */
@Injectable({ providedIn: 'root' })
export class PurchasingApi {
  private readonly api = inject(ApiService);

  private page<T>(path: string, params: Record<string, string | number | undefined>) {
    const clean: Record<string, string | number> = {};
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== '') clean[key] = value;
    }
    return this.api
      .getWithMeta<readonly T[]>(path, { params: clean })
      .pipe(
        map((r): Page<T> => ({ items: r.data, total: Number(r.meta['total'] ?? r.data.length) })),
      );
  }

  // --- fornecedores -----------------------------------------------------------------------------

  suppliers(filter: { q?: string; status?: SupplierStatus; limit?: number }) {
    return this.page<SupplierDto>('suppliers', filter);
  }

  createSupplier(body: {
    partyId: string;
    organizationId: string;
    code: string;
    paymentTermDays?: number;
  }): Observable<SupplierDto> {
    return this.api.post('suppliers', body);
  }

  updateSupplier(
    id: string,
    expectedVersion: number,
    body: { status?: SupplierStatus; statusReason?: string | null; paymentTermDays?: number },
  ): Observable<SupplierDto> {
    return this.api.patch(`suppliers/${id}`, { expectedVersion, ...body });
  }

  /** Contrapartes para o fornecedor (exige `party.read`; sem ele a lista vem vazia e o formulário avisa). */
  parties(q: string): Observable<readonly PartyOption[]> {
    return this.api.get('parties', { params: { q, status: 'ACTIVE', limit: 20 } });
  }

  organizations(): Observable<readonly OrganizationOption[]> {
    return this.api.get('organizations');
  }

  warehouses(): Observable<readonly WarehouseOption[]> {
    return this.api.get('warehouses');
  }

  // --- requisições ------------------------------------------------------------------------------

  requisitions(filter: { status?: RequisitionStatus; limit?: number }) {
    return this.page<RequisitionDto>('purchase-requisitions', filter);
  }

  requisition(id: string): Observable<RequisitionDto> {
    return this.api.get(`purchase-requisitions/${id}`);
  }

  createRequisition(body: {
    organizationId: string;
    neededOn?: string | null;
    notes?: string | null;
    lines: readonly { variantId: string; quantity: string }[];
  }): Observable<RequisitionDto> {
    return this.api.post('purchase-requisitions', body);
  }

  deleteRequisition(id: string): Observable<void> {
    return this.api.delete(`purchase-requisitions/${id}`);
  }

  submitRequisition(id: string): Observable<{ requisition: RequisitionDto; idempotent: boolean }> {
    return this.api.post(`purchase-requisitions/${id}/submit`, {});
  }

  approveRequisition(
    id: string,
    reason?: string,
  ): Observable<{ requisition: RequisitionDto; idempotent: boolean }> {
    return this.api.post(`purchase-requisitions/${id}/approve`, reason ? { reason } : {});
  }

  rejectRequisition(
    id: string,
    reason: string,
  ): Observable<{ requisition: RequisitionDto; idempotent: boolean }> {
    return this.api.post(`purchase-requisitions/${id}/reject`, { reason });
  }

  convertRequisition(
    id: string,
    body: {
      supplierId: string;
      lines: readonly { variantId: string; unitCost: string; taxRate?: string }[];
    },
  ): Observable<{ order: PurchaseDto; idempotent: boolean }> {
    return this.api.post(`purchase-requisitions/${id}/convert`, body);
  }

  // --- encomendas -------------------------------------------------------------------------------

  purchases(filter: { status?: PurchaseStatus; limit?: number }) {
    return this.page<PurchaseDto>('purchase-orders', filter);
  }

  purchase(id: string): Observable<PurchaseDto> {
    return this.api.get(`purchase-orders/${id}`);
  }

  createPurchase(body: { supplierId: string; notes?: string | null }): Observable<PurchaseDto> {
    return this.api.post('purchase-orders', body);
  }

  addPurchaseLine(id: string, line: NewPurchaseLine): Observable<PurchaseDto> {
    return this.api.post(`purchase-orders/${id}/lines`, line);
  }

  removePurchaseLine(id: string, lineId: string): Observable<PurchaseDto> {
    return this.api.delete(`purchase-orders/${id}/lines/${lineId}`);
  }

  deletePurchase(id: string): Observable<void> {
    return this.api.delete(`purchase-orders/${id}`);
  }

  confirmPurchase(id: string): Observable<{ order: PurchaseDto; idempotent: boolean }> {
    return this.api.post(`purchase-orders/${id}/confirm`, {});
  }

  cancelPurchase(
    id: string,
    reason: string,
  ): Observable<{ order: PurchaseDto; idempotent: boolean }> {
    return this.api.post(`purchase-orders/${id}/cancel`, { reason });
  }

  // --- recepções --------------------------------------------------------------------------------

  receipts(filter: { status?: ReceiptStatus; limit?: number }) {
    return this.page<ReceiptDto>('goods-receipts', filter);
  }

  receipt(id: string): Observable<ReceiptDto> {
    return this.api.get(`goods-receipts/${id}`);
  }

  createReceipt(body: {
    purchaseOrderId: string;
    warehouseId?: string | null;
    supplierDocument?: string | null;
    lines: readonly NewReceiptLine[];
  }): Observable<ReceiptDto> {
    return this.api.post('goods-receipts', body);
  }

  deleteReceipt(id: string): Observable<void> {
    return this.api.delete(`goods-receipts/${id}`);
  }

  postReceipt(id: string): Observable<{ receipt: ReceiptDto; idempotent: boolean }> {
    return this.api.post(`goods-receipts/${id}/post`, {});
  }

  reverseReceipt(
    id: string,
    reason: string,
  ): Observable<{ receipt: ReceiptDto; idempotent: boolean }> {
    return this.api.post(`goods-receipts/${id}/reverse`, { reason });
  }
}
