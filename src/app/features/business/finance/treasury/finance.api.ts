import { inject, Injectable } from '@angular/core';
import { map, type Observable } from 'rxjs';
import { ApiService } from '../../../../core/api/api.service';
import type { Page } from '../../sales/orders/orders.api';

export type AccountType = 'CASH' | 'BANK';
export type ObligationKind = 'receivable' | 'payable';
export type ObligationStatus = 'OPEN' | 'CLOSED' | 'CANCELLED';
export type ObligationView = 'OPEN' | 'PARTIAL' | 'OVERDUE' | 'CLOSED' | 'CANCELLED';
export type PaymentDirection = 'INBOUND' | 'OUTBOUND';
export type PaymentMethod = 'CASH' | 'TRANSFER' | 'CARD' | 'OTHER';
export type PaymentStatus = 'DRAFT' | 'PENDING' | 'CONFIRMED' | 'FAILED' | 'REVERSED';
export type SupplierInvoiceStatus = 'DRAFT' | 'VALIDATED' | 'DISPUTED' | 'VOID';

/** Decimais atravessam a API como texto: nunca `number`. */
export interface AccountDto {
  readonly id: string;
  readonly organizationId: string;
  readonly code: string;
  readonly name: string;
  readonly type: AccountType;
  readonly currency: string;
  readonly bankName: string | null;
  /** Sensível: `null` para quem não gere tesouraria. */
  readonly accountIdentifier: string | null;
  readonly active: boolean;
  readonly balance: string;
  readonly version: number;
}

export interface EntryDto {
  readonly id: string;
  readonly accountId: string;
  readonly paymentId: string | null;
  readonly amountSigned: string;
  readonly occurredOn: string;
  readonly reversalOfId: string | null;
}

export interface ObligationDto {
  readonly id: string;
  readonly kind: ObligationKind;
  readonly organizationId: string;
  readonly partyId: string;
  readonly partyName: string;
  readonly sourceType: string;
  readonly sourceId: string;
  readonly originalAmount: string;
  readonly currency: string;
  readonly dueOn: string;
  readonly status: ObligationStatus;
  readonly credits: string;
  readonly paid: string;
  readonly balance: string;
  readonly view: ObligationView;
}

export interface ObligationAllocationDto {
  readonly id: string;
  readonly paymentId: string;
  readonly paymentStatus: PaymentStatus;
  readonly amount: string;
  readonly reversedAt: string | null;
  readonly occurredOn: string;
}

export interface ObligationCreditDto {
  readonly id: string;
  readonly sourceType: string;
  readonly sourceId: string;
  readonly amount: string;
}

export interface ObligationDetailDto extends ObligationDto {
  readonly allocations: readonly ObligationAllocationDto[];
  readonly creditApplications: readonly ObligationCreditDto[];
}

export interface PaymentAllocationDto {
  readonly id: string;
  readonly receivableId: string | null;
  readonly payableId: string | null;
  readonly amount: string;
  readonly reversedAt: string | null;
}

export interface PaymentDto {
  readonly id: string;
  readonly organizationId: string;
  readonly direction: PaymentDirection;
  readonly partyId: string;
  readonly partyName: string;
  readonly treasuryAccountId: string;
  readonly amount: string;
  readonly currency: string;
  readonly method: PaymentMethod;
  readonly occurredOn: string;
  readonly reference: string | null;
  readonly status: PaymentStatus;
  readonly failureReason: string | null;
  readonly reverseReason: string | null;
  readonly version: number;
  readonly allocations?: readonly PaymentAllocationDto[];
}

export interface Discrepancy {
  readonly line: string;
  readonly code: string;
  readonly message: string;
}

export interface SupplierInvoiceLineDto {
  readonly id: string;
  readonly position: number;
  readonly purchaseLineId: string | null;
  readonly description: string;
  readonly quantity: string;
  readonly unitPrice: string;
  readonly taxRate: string;
  readonly netAmount: string;
  readonly taxAmount: string;
  readonly total: string;
}

export interface SupplierInvoiceDto {
  readonly id: string;
  readonly organizationId: string;
  readonly supplierId: string;
  readonly supplierName: string;
  readonly externalNumber: string;
  readonly purchaseOrderId: string | null;
  readonly invoiceDate: string;
  readonly dueOn: string;
  readonly currency: string;
  readonly totals: { readonly net: string; readonly tax: string; readonly total: string };
  readonly status: SupplierInvoiceStatus;
  readonly matching: readonly Discrepancy[] | null;
  readonly overrideReason: string | null;
  readonly notes: string | null;
  readonly version: number;
  readonly lines?: readonly SupplierInvoiceLineDto[];
}

export interface CreditViewDto {
  readonly customerId: string;
  readonly creditLimit: string | null;
  readonly currency: string;
  readonly openReceivables: string;
  readonly reservations: string;
  readonly exposure: string;
  readonly headroom: string | null;
  readonly controlled: boolean;
}

export interface OrganizationOption {
  readonly id: string;
  readonly code: string;
  readonly legalName: string;
}

export interface SupplierOption {
  readonly id: string;
  readonly code: string;
  readonly partyName: string;
  readonly organizationId: string;
}

export interface NewPayment {
  readonly organizationId: string;
  readonly direction: PaymentDirection;
  readonly partyId: string;
  readonly treasuryAccountId: string;
  readonly amount: string;
  readonly method: PaymentMethod;
  readonly reference?: string;
  readonly allocations: readonly {
    readonly receivableId?: string;
    readonly payableId?: string;
    readonly amount: string;
  }[];
}

export interface NewSupplierInvoiceLine {
  readonly description: string;
  readonly quantity: string;
  readonly unitPrice: string;
  readonly taxRate?: string;
}

/** Tesouraria, contas a receber e a pagar (M09) sobre a API real: o servidor calcula saldos e move o dinheiro. */
@Injectable({ providedIn: 'root' })
export class FinanceApi {
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

  // --- contas -----------------------------------------------------------------------------------

  accounts(filter: { active?: string; limit?: number } = {}) {
    return this.page<AccountDto>('treasury-accounts', filter);
  }

  createAccount(body: {
    organizationId: string;
    code: string;
    name: string;
    type: AccountType;
    bankName?: string;
    accountIdentifier?: string;
  }): Observable<AccountDto> {
    return this.api.post('treasury-accounts', body);
  }

  updateAccount(
    id: string,
    expectedVersion: number,
    body: { active?: boolean; name?: string },
  ): Observable<AccountDto> {
    return this.api.patch(`treasury-accounts/${id}`, { expectedVersion, ...body });
  }

  entries(id: string, limit = 50) {
    return this.page<EntryDto>(`treasury-accounts/${id}/entries`, { limit });
  }

  // --- obrigações -------------------------------------------------------------------------------

  obligations(kind: ObligationKind, filter: { view?: ObligationView; limit?: number }) {
    return this.page<ObligationDto>(kind === 'receivable' ? 'receivables' : 'payables', filter);
  }

  obligation(kind: ObligationKind, id: string): Observable<ObligationDetailDto> {
    return this.api.get(`${kind === 'receivable' ? 'receivables' : 'payables'}/${id}`);
  }

  customerCredit(customerId: string): Observable<CreditViewDto> {
    return this.api.get(`customers/${customerId}/credit`);
  }

  // --- pagamentos -------------------------------------------------------------------------------

  payments(filter: { direction?: PaymentDirection; status?: PaymentStatus; limit?: number }) {
    return this.page<PaymentDto>('payments', filter);
  }

  payment(id: string): Observable<PaymentDto> {
    return this.api.get(`payments/${id}`);
  }

  createPayment(body: NewPayment): Observable<PaymentDto> {
    return this.api.post('payments', body);
  }

  submitPayment(id: string): Observable<PaymentDto> {
    return this.api.post(`payments/${id}/submit`, {});
  }

  confirmPayment(id: string): Observable<PaymentDto> {
    return this.api.post(`payments/${id}/confirm`, {});
  }

  failPayment(id: string, reason: string): Observable<PaymentDto> {
    return this.api.post(`payments/${id}/fail`, { reason });
  }

  reversePayment(id: string, reason: string): Observable<PaymentDto> {
    return this.api.post(`payments/${id}/reverse`, { reason });
  }

  deletePayment(id: string): Observable<void> {
    return this.api.delete(`payments/${id}`);
  }

  // --- facturas de fornecedor -------------------------------------------------------------------

  supplierInvoices(filter: { status?: SupplierInvoiceStatus; limit?: number }) {
    return this.page<SupplierInvoiceDto>('supplier-invoices', filter);
  }

  supplierInvoice(id: string): Observable<SupplierInvoiceDto> {
    return this.api.get(`supplier-invoices/${id}`);
  }

  createSupplierInvoice(body: {
    supplierId: string;
    externalNumber: string;
    invoiceDate?: string;
    dueOn?: string;
    notes?: string;
    lines: readonly NewSupplierInvoiceLine[];
  }): Observable<SupplierInvoiceDto> {
    return this.api.post('supplier-invoices', body);
  }

  deleteSupplierInvoice(id: string): Observable<void> {
    return this.api.delete(`supplier-invoices/${id}`);
  }

  validateSupplierInvoice(id: string, overrideReason?: string): Observable<SupplierInvoiceDto> {
    return this.api.post(
      `supplier-invoices/${id}/validate`,
      overrideReason ? { overrideReason } : {},
    );
  }

  voidSupplierInvoice(id: string): Observable<SupplierInvoiceDto> {
    return this.api.post(`supplier-invoices/${id}/void`, {});
  }

  // --- referências ------------------------------------------------------------------------------

  organizations(): Observable<readonly OrganizationOption[]> {
    return this.api.get('organizations');
  }

  suppliers(): Observable<readonly SupplierOption[]> {
    return this.api.get('suppliers', { params: { status: 'ACTIVE', limit: 200 } });
  }
}
