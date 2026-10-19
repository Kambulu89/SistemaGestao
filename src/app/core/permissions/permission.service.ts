import { computed, inject, Injectable } from '@angular/core';
import { AuthService } from '../auth/auth.service';
import { TenantContextService } from '../tenant-context/tenant-context.service';
import { PLATFORM_NAMESPACE, type Permission, permissionMatches } from './permission.model';

/**
 * Consulta de permissões para navegação e UX. Não é segurança: o backend
 * tem de voltar a verificar cada operação.
 *
 * Isolamento de âmbitos: `platform.*` só é concedido pela sessão da plataforma e todas as outras
 * pelo papel do utilizador no tenant activo. Um tenant nunca consegue conceder acesso à plataforma,
 * nem sequer com `*`.
 */
@Injectable({ providedIn: 'root' })
export class PermissionService {
  private readonly auth = inject(AuthService);
  private readonly tenantContext = inject(TenantContextService);

  private readonly platformGranted = computed<readonly Permission[]>(
    () => this.auth.user()?.platformPermissions ?? [],
  );
  private readonly tenantGranted = computed<readonly Permission[]>(
    () => this.tenantContext.active()?.permissions ?? [],
  );

  can(permission: Permission): boolean {
    const granted = permission.startsWith(PLATFORM_NAMESPACE)
      ? this.platformGranted()
      : this.tenantGranted();
    return granted.some((g) => permissionMatches(g, permission));
  }

  canAll(permissions: readonly Permission[]): boolean {
    return permissions.every((p) => this.can(p));
  }
}
