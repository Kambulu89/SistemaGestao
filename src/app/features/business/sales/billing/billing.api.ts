import { inject, Injectable } from '@angular/core';
import { map, type Observable } from 'rxjs';
import { ApiService } from '../../../../core/api/api.service';
import type { Page } from '../orders/orders.api';

export type InvoiceStatus = 'DRAFT' | 'ISSUED' | 'CREDITED';
export type CreditNoteStatus = 'DRAFT' | 'ISSUED';
export type ContractType = 'SALES' | 'PURCHASE' | 'SERVICE';
export type ContractStatus = 'DRAFT' | 'ACTIVE' | 'EXPIRED' | 'TERMINATED';
export type RenewalMode = 'NONE' | 'MANUAL' | 'AUTO';

export interface Totals {
  readonly net: string;
  readonly tax: string;
  readonly total: string;
}

export interface InvoiceLineDto {
  readonly id: string;
  readonly position: number;
  readonly salesOrderLineId: string | null;
  readonly description: string;
  /** Decimais como texto: nunca `number`. */
  readonly quantity: string;
  readonly unitPrice: string;
  readonly discountAmount: string;
  readonly taxCode: string;
  readonly taxRate: string;
  readonly exemptionReason: string | null;
  readonly netAmount: string;
  readonly taxAmount: string;
  readonly total: string;
}

export interface CustomerSnapshot {
  readonly customerCode: string;
  readonly name: string;
  readonly taxCountry: string | null;
  readonly taxId: string | null;
  readonly billingAddress: {
    readonly line1: string;
    readonly line2: string | null;
    readonly city: string;
    readonly postalCode: string | null;
    readonly countryCode: string;
  } | null;
}

export interface InvoiceDto {
  readonly id: string;
  readonly organizationId: string;
  readonly customerId: string;
  readonly contractId: string | null;
  readonly orderId: string | null;
  readonly number: string | null;
  readonly issuedOn: string | null;
  readonly dueOn: string;
  readonly currency: string;
  readonly customerSnapshot: CustomerSnapshot | null;
  readonly totals: Totals;
  readonly status: InvoiceStatus;
  readonly fiscalStatus: string;
  readonly notes: string | null;
  readonly version: number;
  readonly lines?: readonly InvoiceLineDto[];
}

export interface BillableLine {
  readonly orderLineId: string;
  readonly description: string;
  readonly ordered: string;
  readonly shipped: string;
  readonly billed: string;
  readonly billable: string;
  readonly stockTracked: boolean;
}

export interface CreditNoteLineDto {
  readonly id: string;
  readonly invoiceLineId: string;
  readonly quantity: string;
  readonly amount: string;
  readonly taxAmount: string;
}

export interface CreditNoteDto {
  readonly id: string;
  readonly invoiceId: string;
  readonly number: string | null;
  readonly issuedOn: string | null;
  readonly reason: string;
  readonly totals: Totals;
  readonly status: CreditNoteStatus;
  readonly version: number;
  readonly lines?: readonly CreditNoteLineDto[];
}

export interface ContractDto {
  readonly id: string;
  readonly organizationId: string;
  readonly partyId: string;
  readonly type: ContractType;
  readonly title: string;
  readonly number: string | null;
  readonly startDate: string;
  readonly endDate: string | null;
  readonly currency: string;
  readonly amount: string | null;
  readonly renewalMode: RenewalMode;
  readonly noticeDays: number;
  readonly status: Exclude<ContractStatus, 'EXPIRED'>;
  /** Estado em vigor: um contrato activo cujo fim passou aparece como `EXPIRED`. */
  readonly effectiveStatus: ContractStatus;
  readonly noticeDeadline: string | null;
  readonly terminateReason: string | null;
  readonly notes: string | null;
  readonly version: number;
}

export interface ManualLine {
  readonly description: string;
  readonly quantity: string;
  readonly unitPrice: string;
  readonly taxRate: string;
  readonly exemptionReason?: string;
}

export interface PartyOption {
  readonly id: string;
  readonly displayName: string;
}

export interface NewContract {
  readonly organizationId: string;
  readonly partyId: string;
  readonly type: ContractType;
  readonly title: string;
  readonly startDate: string;
  readonly endDate?: string | null;
  readonly amount?: string | null;
  readonly renewalMode?: RenewalMode;
  readonly noticeDays?: number;
}

/** Facturas, notas de crédito e contratos (M05) sobre a API real: o servidor calcula, numera e fixa o que se emite. */
@Injectable({ providedIn: 'root' })
export class BillingApi {
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

  // --- facturas ---------------------------------------------------------------------------------

  invoices(filter: {
    status?: InvoiceStatus;
    q?: string;
    limit?: number;
  }): Observable<Page<InvoiceDto>> {
    return this.page('invoices', filter);
  }

  invoice(id: string): Observable<InvoiceDto> {
    return this.api.get(`invoices/${id}`);
  }

  billable(orderId: string): Observable<readonly BillableLine[]> {
    return this.api.get(`sales-orders/${orderId}/billable`);
  }

  createInvoice(body: {
    orderId?: string;
    organizationId?: string;
    customerId?: string;
    dueOn?: string;
    lines?: readonly { orderLineId: string; quantity: string }[];
  }): Observable<InvoiceDto> {
    return this.api.post('invoices', body);
  }

  addInvoiceLine(id: string, line: ManualLine): Observable<InvoiceDto> {
    return this.api.post(`invoices/${id}/lines`, line);
  }

  removeInvoiceLine(id: string, lineId: string): Observable<InvoiceDto> {
    return this.api.delete(`invoices/${id}/lines/${lineId}`);
  }

  updateInvoice(id: string, expectedVersion: number, dueOn: string): Observable<InvoiceDto> {
    return this.api.patch(`invoices/${id}`, { expectedVersion, dueOn });
  }

  deleteInvoice(id: string): Observable<void> {
    return this.api.delete(`invoices/${id}`);
  }

  issueInvoice(id: string): Observable<{ invoice: InvoiceDto; idempotent: boolean }> {
    return this.api.post(`invoices/${id}/issue`, {});
  }

  // --- notas de crédito -------------------------------------------------------------------------

  creditNotes(filter: {
    status?: CreditNoteStatus;
    limit?: number;
  }): Observable<Page<CreditNoteDto>> {
    return this.page('credit-notes', filter);
  }

  creditNote(id: string): Observable<CreditNoteDto> {
    return this.api.get(`credit-notes/${id}`);
  }

  createCreditNote(body: {
    invoiceId: string;
    reason: string;
    lines: readonly { invoiceLineId: string; quantity: string }[];
  }): Observable<CreditNoteDto> {
    return this.api.post('credit-notes', body);
  }

  deleteCreditNote(id: string): Observable<void> {
    return this.api.delete(`credit-notes/${id}`);
  }

  issueCreditNote(id: string): Observable<{ creditNote: CreditNoteDto; idempotent: boolean }> {
    return this.api.post(`credit-notes/${id}/issue`, {});
  }

  // --- contratos --------------------------------------------------------------------------------

  contracts(filter: {
    status?: ContractStatus;
    q?: string;
    limit?: number;
  }): Observable<Page<ContractDto>> {
    return this.page('contracts', filter);
  }

  contract(id: string): Observable<ContractDto> {
    return this.api.get(`contracts/${id}`);
  }

  createContract(body: NewContract): Observable<ContractDto> {
    return this.api.post('contracts', body);
  }

  updateContract(
    id: string,
    expectedVersion: number,
    body: {
      title?: string;
      endDate?: string | null;
      amount?: string | null;
      renewalMode?: RenewalMode;
      noticeDays?: number;
    },
  ): Observable<ContractDto> {
    return this.api.patch(`contracts/${id}`, { expectedVersion, ...body });
  }

  activateContract(id: string): Observable<{ contract: ContractDto; idempotent: boolean }> {
    return this.api.post(`contracts/${id}/activate`, {});
  }

  terminateContract(
    id: string,
    reason: string,
  ): Observable<{ contract: ContractDto; idempotent: boolean }> {
    return this.api.post(`contracts/${id}/terminate`, { reason });
  }

  /** Contrapartes para o contrato (exige `party.read`; sem ele a lista vem vazia e o formulário avisa). */
  parties(q: string): Observable<readonly PartyOption[]> {
    return this.api.get('parties', { params: { q, status: 'ACTIVE', limit: 20 } });
  }
}
