import { inject, Injectable } from '@angular/core';
import type { Observable } from 'rxjs';
import { ApiService } from '../../../core/api/api.service';

export type MemberStatus = 'INVITED' | 'ACTIVE' | 'SUSPENDED' | 'LEFT';
export type InvitationStatus = 'PENDING' | 'ACCEPTED' | 'REVOKED' | 'EXPIRED';

export interface MemberDto {
  readonly id: string;
  readonly userId: string;
  readonly email: string | null;
  readonly displayName: string | null;
  readonly status: MemberStatus;
  readonly joinedAt: string | null;
  readonly authorizationVersion: number;
  readonly version: number;
  readonly roles: readonly { assignmentId: string; roleId: string; roleCode: string }[];
}

export interface InvitationDto {
  readonly id: string;
  readonly email: string;
  readonly status: InvitationStatus;
  readonly expiresAt: string;
  readonly roleIds: readonly string[];
  readonly version: number;
}

export interface RoleDto {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly description: string | null;
  readonly isSystem: boolean;
  readonly version: number;
  readonly permissionCodes: readonly string[];
}

export interface PermissionDto {
  readonly id: string;
  readonly code: string;
  readonly moduleCode: string;
  readonly description: string;
}

export interface RoleBody {
  readonly name: string;
  readonly description: string | null;
  readonly permissionCodes: readonly string[];
}

export interface AssignmentDto {
  readonly id: string;
  readonly membershipId: string;
  readonly roleId: string;
  readonly organizationUnitId: string | null;
  readonly validFrom: string | null;
  readonly validUntil: string | null;
}

export interface AssignmentBody {
  readonly membershipId: string;
  readonly roleId: string;
  readonly organizationUnitId?: string | null;
  readonly validFrom?: string | null;
  readonly validUntil?: string | null;
}

export type PolicyEffect = 'ALLOW' | 'DENY';
export type PolicyStatus = 'DRAFT' | 'ACTIVE' | 'DISABLED';

export interface FieldRuleDto {
  readonly field: string;
  readonly mode: 'HIDDEN' | 'READ_ONLY';
  readonly when?: unknown;
}

export interface PolicyDto {
  readonly id: string;
  readonly name: string;
  readonly resource: string;
  readonly action: string;
  readonly effect: PolicyEffect;
  /** AST declarativa das políticas de acesso (`subject.*`, `resource.*`, `env.*`); `null` = sempre. */
  readonly condition: unknown;
  readonly priority: number;
  readonly status: PolicyStatus;
  readonly fieldRules: readonly FieldRuleDto[];
  readonly version: number;
}

export interface PolicyBody {
  readonly name: string;
  readonly resource: string;
  readonly action: string;
  readonly effect: PolicyEffect;
  readonly condition?: unknown;
  readonly priority: number;
  readonly status: PolicyStatus;
  readonly fieldRules: readonly FieldRuleDto[];
}

export interface DecisionDto {
  readonly allowed: boolean;
  readonly reason: string;
  readonly grantedBy: readonly { roleId: string; roleCode: string }[];
  readonly policies: readonly { id: string; name: string; effect: PolicyEffect }[];
  readonly hiddenFields: readonly string[];
  readonly readOnlyFields: readonly string[];
}

export interface ScopeDto {
  readonly id: string;
  readonly membershipId: string;
  readonly organizationId: string;
  readonly organizationUnitId: string | null;
  readonly includeDescendants: boolean;
}

/** Membros, convites e papéis do tenant activo (C05/C06). Autorização e isolamento são do servidor. */
@Injectable({ providedIn: 'root' })
export class IamApi {
  private readonly api = inject(ApiService);

  listMembers(): Observable<readonly MemberDto[]> {
    return this.api.get('memberships');
  }

  changeMemberStatus(
    member: Pick<MemberDto, 'id' | 'version'>,
    status: Exclude<MemberStatus, 'INVITED'>,
  ): Observable<MemberDto> {
    return this.api.patch(`memberships/${member.id}`, { status, expectedVersion: member.version });
  }

  listInvitations(): Observable<readonly InvitationDto[]> {
    return this.api.get('invitations');
  }

  invite(email: string, roleIds: readonly string[]): Observable<InvitationDto> {
    return this.api.post('invitations', { email, roleIds });
  }

  revokeInvitation(id: string): Observable<void> {
    return this.api.post(`invitations/${id}/revoke`, {});
  }

  listRoles(): Observable<readonly RoleDto[]> {
    return this.api.get('roles');
  }

  permissions(): Observable<readonly PermissionDto[]> {
    return this.api.get('permissions');
  }

  createRole(code: string, body: RoleBody): Observable<RoleDto> {
    return this.api.post('roles', { code, ...body });
  }

  updateRole(id: string, expectedVersion: number, body: Partial<RoleBody>): Observable<RoleDto> {
    return this.api.patch(`roles/${id}`, { expectedVersion, ...body });
  }

  deleteRole(id: string): Observable<void> {
    return this.api.delete(`roles/${id}`);
  }

  assignments(membershipId?: string): Observable<readonly AssignmentDto[]> {
    return this.api.get('role-assignments', {
      params: membershipId ? { membershipId } : undefined,
    });
  }

  assign(body: AssignmentBody): Observable<AssignmentDto> {
    return this.api.post('role-assignments', body);
  }

  revokeAssignment(id: string): Observable<void> {
    return this.api.delete(`role-assignments/${id}`);
  }

  policies(): Observable<readonly PolicyDto[]> {
    return this.api.get('access-policies');
  }

  createPolicy(body: PolicyBody): Observable<PolicyDto> {
    return this.api.post('access-policies', body);
  }

  updatePolicy(
    id: string,
    expectedVersion: number,
    body: Partial<PolicyBody>,
  ): Observable<PolicyDto> {
    return this.api.patch(`access-policies/${id}`, { expectedVersion, ...body });
  }

  simulate(body: {
    membershipId: string;
    permission: string;
    resource?: Record<string, unknown>;
  }): Observable<DecisionDto> {
    return this.api.post('authorization/simulate', body);
  }

  scopes(membershipId?: string): Observable<readonly ScopeDto[]> {
    return this.api.get('membership-scopes', {
      params: membershipId ? { membershipId } : undefined,
    });
  }

  addScope(body: {
    membershipId: string;
    organizationId: string;
    organizationUnitId?: string | null;
    includeDescendants?: boolean;
  }): Observable<ScopeDto> {
    return this.api.post('membership-scopes', body);
  }

  removeScope(id: string): Observable<void> {
    return this.api.delete(`membership-scopes/${id}`);
  }
}
