import { inject, Injectable } from '@angular/core';
import type { Observable } from 'rxjs';
import { ApiService } from '../../../core/api/api.service';

export type UnitType = 'BRANCH' | 'DEPARTMENT' | 'SECTION' | 'TEAM' | 'OTHER';

export interface OrganizationDto {
  readonly id: string;
  readonly code: string;
  readonly legalName: string;
  readonly tradeName: string | null;
  readonly countryCode: string;
  readonly baseCurrency: string;
  readonly active: boolean;
  readonly version: number;
}

export interface UnitDto {
  readonly id: string;
  readonly organizationId: string;
  readonly parentId: string | null;
  readonly code: string;
  readonly name: string;
  readonly type: UnitType;
  readonly active: boolean;
  readonly version: number;
}

export interface NewUnit {
  readonly organizationId: string;
  readonly parentId: string | null;
  readonly code: string;
  readonly name: string;
  readonly type: UnitType;
}

/** Organizações e unidades do tenant activo (C07). */
@Injectable({ providedIn: 'root' })
export class OrganizationApi {
  private readonly api = inject(ApiService);

  listOrganizations(): Observable<readonly OrganizationDto[]> {
    return this.api.get('organizations');
  }

  listUnits(organizationId: string): Observable<readonly UnitDto[]> {
    return this.api.get('organization-units', { params: { organizationId } });
  }

  createUnit(unit: NewUnit): Observable<UnitDto> {
    return this.api.post('organization-units', unit);
  }

  setUnitActive(unit: Pick<UnitDto, 'id' | 'version'>, active: boolean): Observable<UnitDto> {
    return this.api.patch(`organization-units/${unit.id}`, {
      expectedVersion: unit.version,
      active,
    });
  }
}
