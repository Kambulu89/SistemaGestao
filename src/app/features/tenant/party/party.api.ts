import { inject, Injectable } from '@angular/core';
import type { Observable } from 'rxjs';
import { ApiService } from '../../../core/api/api.service';

export type PartyKind = 'PERSON' | 'ORGANIZATION';
export type PartyStatus = 'ACTIVE' | 'INACTIVE';
export type ContactType = 'EMAIL' | 'PHONE' | 'WEBSITE';
export type AddressType = 'BILLING' | 'DELIVERY' | 'OTHER';
export type DuplicateReason = 'IDENTITY' | 'TAX_ID' | 'CONTACT';

export interface PartyDto {
  readonly id: string;
  readonly kind: PartyKind;
  readonly displayName: string;
  readonly status: PartyStatus;
  readonly externalReference: string | null;
  readonly version: number;
}

/** Os campos sensíveis (data de nascimento, nacionalidade, identificação) desaparecem quando uma regra de campo os esconde. */
export interface PersonDto {
  readonly id: string;
  readonly givenNames: string;
  readonly familyName: string;
  readonly birthDate?: string | null;
  readonly nationality?: string | null;
  readonly identityType?: string | null;
  readonly identityNumber?: string | null;
}

export interface OrganizationPartyDto {
  readonly id: string;
  readonly legalName: string;
  readonly taxCountry?: string | null;
  readonly taxId?: string | null;
  readonly registrationNumber?: string | null;
}

export interface ContactDto {
  readonly id: string;
  readonly partyId: string;
  readonly type: ContactType;
  readonly value: string;
  readonly label: string | null;
  readonly isPrimary: boolean;
  readonly version: number;
}

export interface AddressDto {
  readonly id: string;
  readonly partyId: string;
  readonly type: AddressType;
  readonly line1: string;
  readonly line2: string | null;
  readonly city: string;
  readonly province: string | null;
  readonly countryCode: string;
  readonly postalCode: string | null;
  readonly isPrimary: boolean;
  readonly version: number;
}

export interface RelationshipDto {
  readonly id: string;
  readonly sourcePartyId: string;
  readonly targetPartyId: string;
  readonly relationshipType: string;
  readonly startsOn: string | null;
  readonly endsOn: string | null;
}

export interface DuplicateDto {
  readonly partyId: string;
  readonly displayName: string;
  readonly reasons: readonly DuplicateReason[];
}

export interface PartyDetailDto extends PartyDto {
  readonly person: PersonDto | null;
  readonly organization: OrganizationPartyDto | null;
  readonly contacts: readonly ContactDto[];
  readonly addresses: readonly AddressDto[];
  readonly possibleDuplicates: readonly DuplicateDto[];
}

export interface PartyFilter {
  readonly kind?: PartyKind;
  readonly status?: PartyStatus;
  readonly q?: string;
  readonly limit: number;
  readonly offset: number;
}

export interface ContactBody {
  readonly type: ContactType;
  readonly value: string;
  readonly label?: string | null;
  readonly isPrimary?: boolean;
}

export interface AddressBody {
  readonly type: AddressType;
  readonly line1: string;
  readonly line2?: string | null;
  readonly city: string;
  readonly province?: string | null;
  readonly countryCode: string;
  readonly postalCode?: string | null;
  readonly isPrimary?: boolean;
}

export interface NewPerson {
  readonly displayName?: string | null;
  readonly externalReference?: string | null;
  readonly givenNames: string;
  readonly familyName: string;
  readonly birthDate?: string | null;
  readonly nationality?: string | null;
  readonly identityType?: string | null;
  readonly identityNumber?: string | null;
}

export interface NewOrganizationParty {
  readonly displayName?: string | null;
  readonly externalReference?: string | null;
  readonly legalName: string;
  readonly taxCountry?: string | null;
  readonly taxId?: string | null;
  readonly registrationNumber?: string | null;
}

export interface PartyChanges {
  readonly displayName?: string;
  readonly status?: PartyStatus;
  readonly externalReference?: string | null;
  readonly person?: Partial<Omit<PersonDto, 'id'>>;
  readonly organization?: Partial<Omit<OrganizationPartyDto, 'id'>>;
}

/** Party (C08): pessoas e organizações externas, contactos, moradas e relações. Autorização e campos escondidos são do servidor. */
@Injectable({ providedIn: 'root' })
export class PartyApi {
  private readonly api = inject(ApiService);

  list(filter: PartyFilter): Observable<readonly PartyDto[]> {
    const params: Record<string, string | number> = {
      limit: filter.limit,
      offset: filter.offset,
    };
    if (filter.kind) params['kind'] = filter.kind;
    if (filter.status) params['status'] = filter.status;
    if (filter.q) params['q'] = filter.q;
    return this.api.get('parties', { params });
  }

  get(id: string): Observable<PartyDetailDto> {
    return this.api.get(`parties/${id}`);
  }

  createPerson(body: NewPerson): Observable<PartyDetailDto> {
    return this.api.post('people', body);
  }

  createOrganization(body: NewOrganizationParty): Observable<PartyDetailDto> {
    return this.api.post('organization-parties', body);
  }

  update(
    party: Pick<PartyDto, 'id' | 'version'>,
    changes: PartyChanges,
  ): Observable<PartyDetailDto> {
    return this.api.patch(`parties/${party.id}`, { expectedVersion: party.version, ...changes });
  }

  addContact(partyId: string, body: ContactBody): Observable<ContactDto> {
    return this.api.post(`parties/${partyId}/contacts`, body);
  }

  updateContact(
    contact: Pick<ContactDto, 'id' | 'version'>,
    changes: { value?: string; label?: string | null; isPrimary?: boolean },
  ): Observable<ContactDto> {
    return this.api.patch(`contacts/${contact.id}`, {
      expectedVersion: contact.version,
      ...changes,
    });
  }

  removeContact(id: string): Observable<void> {
    return this.api.delete(`contacts/${id}`);
  }

  addAddress(partyId: string, body: AddressBody): Observable<AddressDto> {
    return this.api.post(`parties/${partyId}/addresses`, body);
  }

  updateAddress(
    address: Pick<AddressDto, 'id' | 'version'>,
    changes: Partial<AddressBody>,
  ): Observable<AddressDto> {
    return this.api.patch(`addresses/${address.id}`, {
      expectedVersion: address.version,
      ...changes,
    });
  }

  removeAddress(id: string): Observable<void> {
    return this.api.delete(`addresses/${id}`);
  }

  relationships(partyId: string): Observable<readonly RelationshipDto[]> {
    return this.api.get(`parties/${partyId}/relationships`);
  }

  addRelationship(
    partyId: string,
    body: {
      targetPartyId: string;
      relationshipType: string;
      startsOn?: string | null;
      endsOn?: string | null;
    },
  ): Observable<RelationshipDto> {
    return this.api.post(`parties/${partyId}/relationships`, body);
  }

  removeRelationship(id: string): Observable<void> {
    return this.api.delete(`party-relationships/${id}`);
  }
}
