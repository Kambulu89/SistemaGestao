import { computed, inject, Injectable } from '@angular/core';
import { ModuleRegistryService } from '../modules/module-registry.service';
import type { ModuleGroup } from '../modules/module.model';
import { PLATFORM_PERMISSIONS, TENANT_PERMISSIONS } from '../permissions/permission.model';
import { PermissionService } from '../permissions/permission.service';
import { TenantContextService } from '../tenant-context/tenant-context.service';
import type { NavGroup, NavItem } from './navigation.model';

const MODULE_GROUP_LABELS: Record<ModuleGroup, string> = {
  general: 'Módulos',
  dynamic: 'Personalização',
  vertical: 'Verticais',
};
const MODULE_GROUP_ORDER: readonly ModuleGroup[] = ['general', 'dynamic', 'vertical'];

/**
 * Constrói os menus. O menu do tenant resulta de: catálogo ∩ módulos contratados e activados
 * ∩ dependências ∩ feature flags ∩ permissões (ver `resolveModuleAccess`).
 */
@Injectable({ providedIn: 'root' })
export class NavigationService {
  private readonly permissions = inject(PermissionService);
  private readonly tenantContext = inject(TenantContextService);
  private readonly registry = inject(ModuleRegistryService);

  readonly platformNav = computed<readonly NavGroup[]>(() => {
    const items = this.visible([
      { label: 'Painel', path: '/platform', icon: 'dashboard', exact: true },
      {
        label: 'Tenants',
        path: '/platform/tenants',
        icon: 'building',
        permission: PLATFORM_PERMISSIONS.tenantsRead,
      },
      {
        label: 'Planos',
        path: '/platform/plans',
        icon: 'card',
        permission: PLATFORM_PERMISSIONS.plansRead,
      },
      {
        label: 'Subscrições',
        path: '/platform/subscriptions',
        icon: 'shield',
        permission: PLATFORM_PERMISSIONS.subscriptionsRead,
      },
    ]);
    return [{ id: 'platform', items }];
  });

  readonly tenantNav = computed<readonly NavGroup[]>(() => {
    const slug = this.tenantContext.tenant()?.slug;
    if (!slug) return [];
    const base = `/t/${slug}`;

    const groups: NavGroup[] = [
      {
        id: 'organization',
        items: this.visible([
          { label: 'Painel', path: base, icon: 'dashboard', exact: true },
          {
            label: 'Organização',
            path: `${base}/organization`,
            icon: 'building',
            permission: TENANT_PERMISSIONS.organizationRead,
          },
          {
            label: 'Utilizadores',
            path: `${base}/users`,
            icon: 'users',
            permission: TENANT_PERMISSIONS.usersRead,
          },
          {
            label: 'Configurações',
            path: `${base}/settings`,
            icon: 'settings',
            permission: TENANT_PERMISSIONS.settingsRead,
          },
        ]),
      },
    ];

    for (const group of MODULE_GROUP_ORDER) {
      const items = this.registry
        .accessible()
        .filter((m) => m.manifest.group === group)
        .map<NavItem>(({ manifest }) => ({
          label: manifest.name,
          path: `${base}/modules/${manifest.id}`,
          icon: manifest.icon,
        }));
      if (items.length > 0) {
        groups.push({ id: group, label: MODULE_GROUP_LABELS[group], items });
      }
    }
    return groups;
  });

  private visible(entries: readonly (NavItem & { permission?: string })[]): NavItem[] {
    return entries
      .filter((e) => !e.permission || this.permissions.can(e.permission))
      .map(({ label, path, icon, exact }) => ({ label, path, icon, exact }));
  }
}
