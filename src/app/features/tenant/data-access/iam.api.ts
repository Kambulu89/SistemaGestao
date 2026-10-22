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
}
