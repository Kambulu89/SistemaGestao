import { computed, inject, Injectable } from '@angular/core';
import { AuthService } from '../auth/auth.service';
import { TenantContextService } from '../tenant-context/tenant-context.service';
import { type Permission, permissionMatches } from './permission.model';

/**
 * Consulta de permissões para navegação e UX. Não é segurança: o backend
 * tem de voltar a verificar cada operação.
 */
@Injectable({ providedIn: 'root' })
export class PermissionService {
  private readonly auth = inject(AuthService);
  private readonly tenantContext = inject(TenantContextService);

  private readonly granted = computed<readonly Permission[]>(() => [
    ...(this.auth.user()?.platformPermissions ?? []),
    ...(this.tenantContext.active()?.permissions ?? []),
  ]);

  can(permission: Permission): boolean {
    return this.granted().some((g) => permissionMatches(g, permission));
  }

  canAll(permissions: readonly Permission[]): boolean {
    return permissions.every((p) => this.can(p));
  }
}
