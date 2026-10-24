import { inject, Injectable } from '@angular/core';
import { map, type Observable } from 'rxjs';
import { ApiService } from '../../../../core/api/api.service';

export type CustomerStatus = 'ACTIVE' | 'BLOCKED' | 'INACTIVE';
export type Channel = 'CALL' | 'EMAIL' | 'MEETING' | 'NOTE';

export interface SegmentDto {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly description: string | null;
  readonly active: boolean;
  readonly version: number;
}

export interface ContactDto {
  readonly id: string;
  readonly type: string;
  readonly value: string;
  readonly label: string | null;
  readonly isPrimary: boolean;
}

export interface CustomerDto {
  readonly id: string;
  readonly partyId: string;
  readonly organizationId: string;
  readonly code: string;
  readonly segmentId: string | null;
  readonly accountManagerMembershipId: string | null;
  readonly paymentTermDays: number;
  /** Texto decimal; `null` para quem não tem `customer.credit_manage`. */
  readonly creditLimit: string | null;
  readonly currency: string;
  readonly status: CustomerStatus;
  readonly statusReason: string | null;
  readonly version: number;
  readonly partyName: string;
  readonly partyKind: string;
  readonly taxId: string | null;
  readonly segmentName: string | null;
  /** Só no detalhe, e só a quem pode ler a Party. */
  readonly contacts?: readonly ContactDto[];
}

export interface CustomerFilter {
  readonly q?: string;
  readonly status?: CustomerStatus;
  readonly segmentId?: string;
  readonly limit?: number;
  readonly offset?: number;
}

export interface CustomerPage {
  readonly items: readonly CustomerDto[];
  readonly total: number;
}

export interface NewCustomer {
  readonly partyId: string;
  readonly organizationId: string;
  readonly code: string;
  readonly segmentId?: string | null;
  readonly accountManagerMembershipId?: string | null;
  readonly paymentTermDays?: number;
  readonly creditLimit?: string;
  readonly currency?: string;
}

export interface CustomerPatch {
  readonly segmentId?: string | null;
  readonly accountManagerMembershipId?: string | null;
  readonly paymentTermDays?: number;
  readonly creditLimit?: string;
  readonly currency?: string;
  readonly status?: 'ACTIVE' | 'INACTIVE';
}

export interface InteractionDto {
  readonly id: string;
  readonly partyId: string;
  readonly channel: Channel;
  readonly subject: string;
  readonly occurredAt: string;
  readonly ownerMembershipId: string;
  readonly summary: string;
  readonly followUpAt: string | null;
  readonly version: number;
}

export interface NewInteraction {
  readonly partyId: string;
  readonly channel: Channel;
  readonly subject: string;
  readonly occurredAt?: string;
  readonly summary?: string;
  readonly followUpAt?: string | null;
}

export interface PartyDto {
  readonly id: string;
  readonly kind: 'PERSON' | 'ORGANIZATION';
  readonly displayName: string;
}

/** Clientes (M01) sobre a API real: o servidor valida, protege o crédito e garante a unicidade. */
@Injectable({ providedIn: 'root' })
export class CustomersApi {
  private readonly api = inject(ApiService);

  segments(): Observable<readonly SegmentDto[]> {
    return this.api.get('customer-segments');
  }

  createSegment(body: {
    code: string;
    name: string;
    description?: string | null;
  }): Observable<SegmentDto> {
    return this.api.post('customer-segments', body);
  }

  updateSegment(
    id: string,
    expectedVersion: number,
    body: { name?: string; description?: string | null; active?: boolean },
  ): Observable<SegmentDto> {
    return this.api.patch(`customer-segments/${id}`, { expectedVersion, ...body });
  }

  customers(filter: CustomerFilter): Observable<CustomerPage> {
    const params: Record<string, string | number | boolean> = {};
    for (const [key, value] of Object.entries(filter)) {
      if (value !== undefined && value !== '') params[key] = value;
    }
    return this.api
      .getWithMeta<readonly CustomerDto[]>('customers', { params })
      .pipe(map((r) => ({ items: r.data, total: Number(r.meta['total'] ?? r.data.length) })));
  }

  customer(id: string): Observable<CustomerDto> {
    return this.api.get(`customers/${id}`);
  }

  createCustomer(body: NewCustomer): Observable<CustomerDto> {
    return this.api.post('customers', body);
  }

  updateCustomer(
    id: string,
    expectedVersion: number,
    body: CustomerPatch,
  ): Observable<CustomerDto> {
    return this.api.patch(`customers/${id}`, { expectedVersion, ...body });
  }

  block(id: string, expectedVersion: number, reason: string): Observable<CustomerDto> {
    return this.api.post(`customers/${id}/block`, { expectedVersion, reason });
  }

  unblock(id: string, expectedVersion: number): Observable<CustomerDto> {
    return this.api.post(`customers/${id}/unblock`, { expectedVersion });
  }

  interactions(partyId: string): Observable<readonly InteractionDto[]> {
    return this.api.get('interactions', { params: { partyId, limit: 100 } });
  }

  createInteraction(body: NewInteraction): Observable<InteractionDto> {
    return this.api.post('interactions', body);
  }

  /** Procura de Party para o cadastro (exige `party.read`). */
  searchParties(q: string): Observable<readonly PartyDto[]> {
    return this.api.get('parties', { params: { q, status: 'ACTIVE', limit: 20 } });
  }

  createOrganizationParty(body: {
    legalName: string;
    taxId?: string | null;
    taxCountry?: string | null;
  }): Observable<{ id: string; displayName: string }> {
    return this.api.post('organization-parties', body);
  }

  createPerson(body: {
    givenNames: string;
    familyName: string;
  }): Observable<{ id: string; displayName: string }> {
    return this.api.post('people', body);
  }
}
