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

export interface CostCenterDto {
  readonly id: string;
  readonly organizationId: string;
  readonly parentId: string | null;
  readonly code: string;
  readonly name: string;
  readonly responsibleMembershipId: string | null;
  readonly active: boolean;
  readonly version: number;
}

/** Cargo (função) da estrutura: existe sem ocupante e pode ter vários (o RH liga-lhe os contratos). */
export interface PositionDto {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly description: string | null;
  readonly jobFamily: string | null;
  readonly category: string | null;
  readonly hierarchyLevel: number | null;
  readonly departmentId: string | null;
  readonly parentId: string | null;
  readonly responsibilities: string | null;
  readonly competencies: readonly string[];
  readonly academicRequirements: string | null;
  readonly recommendedExperience: string | null;
  readonly status: 'ACTIVE' | 'INACTIVE';
  readonly version: number;
}

export type PositionInput = Partial<
  Omit<PositionDto, 'id' | 'version' | 'code' | 'competencies'> & {
    competencies: readonly string[];
  }
>;

export interface NewCostCenter {
  readonly organizationId: string;
  readonly parentId?: string | null;
  readonly code: string;
  readonly name: string;
  readonly responsibleMembershipId?: string | null;
}

export interface TeamMemberDto {
  readonly id: string;
  readonly unitId: string;
  readonly membershipId: string;
  readonly startsOn: string;
  readonly endsOn: string | null;
  readonly roleLabel: string | null;
}

export interface NewTeamMember {
  readonly membershipId: string;
  readonly startsOn: string;
  readonly endsOn?: string | null;
  readonly roleLabel?: string | null;
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

  listPositions(filter: {
    q?: string;
    status?: 'ACTIVE' | 'INACTIVE';
    departmentId?: string;
  }): Observable<readonly PositionDto[]> {
    const params: Record<string, string> = { limit: '200' };
    for (const [key, value] of Object.entries(filter)) if (value) params[key] = value;
    return this.api.get('positions', { params });
  }

  createPosition(body: PositionInput & { code: string; name: string }): Observable<PositionDto> {
    return this.api.post('positions', body);
  }

  updatePosition(
    position: Pick<PositionDto, 'id' | 'version'>,
    changes: PositionInput,
  ): Observable<PositionDto> {
    return this.api.patch(`positions/${position.id}`, {
      expectedVersion: position.version,
      ...changes,
    });
  }

  listCostCenters(organizationId: string): Observable<readonly CostCenterDto[]> {
    return this.api.get('cost-centers', { params: { organizationId } });
  }

  createCostCenter(body: NewCostCenter): Observable<CostCenterDto> {
    return this.api.post('cost-centers', body);
  }

  updateCostCenter(
    center: Pick<CostCenterDto, 'id' | 'version'>,
    changes: {
      name?: string;
      parentId?: string | null;
      responsibleMembershipId?: string | null;
      active?: boolean;
    },
  ): Observable<CostCenterDto> {
    return this.api.patch(`cost-centers/${center.id}`, {
      expectedVersion: center.version,
      ...changes,
    });
  }

  listTeam(unitId: string): Observable<readonly TeamMemberDto[]> {
    return this.api.get(`organization-units/${unitId}/members`);
  }

  addTeamMember(unitId: string, body: NewTeamMember): Observable<TeamMemberDto> {
    return this.api.post(`organization-units/${unitId}/members`, body);
  }

  removeTeamMember(id: string): Observable<void> {
    return this.api.delete(`team-members/${id}`);
  }
}
