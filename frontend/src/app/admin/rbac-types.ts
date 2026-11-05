export interface Role {
  id: string;
  code: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  status: 'ACTIVE' | 'INACTIVE';
  permissionCodes: string[];
  version: number;
}

export interface PermissionDefinition {
  code: string;
  module: string;
  description: string;
}

export interface MemberRole {
  id: string;
  roleId: string;
  roleCode: string;
  scopeType: string;
  scopeId: string | null;
}

export interface Member {
  id: string;
  userId: string;
  email: string;
  fullName: string;
  status: 'INVITED' | 'ACTIVE' | 'SUSPENDED' | 'REVOKED';
  joinedAt: string | null;
  invitedAt: string | null;
  version: number;
  roles: MemberRole[];
}

/** Âmbito → segmento da lista organizacional de onde se escolhe o alvo. */
export const SCOPE_TARGETS: Record<string, string> = {
  LEGAL_ENTITY: 'legal-entities',
  BRANCH: 'branches',
  DEPARTMENT: 'departments',
};
