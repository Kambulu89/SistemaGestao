import { computed, inject, Injectable } from '@angular/core';
import { ModuleRegistryService } from '../modules/module-registry.service';
import { TenantModulesService } from '../modules/tenant-modules.service';
import { PLATFORM_PERMISSIONS, TENANT_PERMISSIONS } from '../permissions/permission.model';
import { PermissionService } from '../permissions/permission.service';
import { TenantContextService } from '../tenant-context/tenant-context.service';
import type { NavGroup, NavItem } from './navigation.model';

type Entry = NavItem & { readonly permission?: string };

/**
 * Constrói os menus. O menu do tenant junta as páginas de administração com um item por módulo
 * *acessível* (contratado ∩ activado ∩ dependências ∩ feature flag ∩ permissão), agrupado
 * pelos grupos do catálogo. Um módulo novo aparece sem tocar neste serviço.
 */
@Injectable({ providedIn: 'root' })
export class NavigationService {
  private readonly permissions = inject(PermissionService);
  private readonly tenantContext = inject(TenantContextService);
  private readonly registry = inject(ModuleRegistryService);
  private readonly tenantModules = inject(TenantModulesService);

  readonly platformNav = computed<readonly NavGroup[]>(() => [
    {
      id: 'platform',
      items: this.visible([
        { label: 'Painel', path: '/platform', icon: 'dashboard', exact: true },
        {
          label: 'Tenants',
          path: '/platform/tenants',
          icon: 'building',
          permission: PLATFORM_PERMISSIONS.tenantsRead,
        },
        {
          label: 'Catálogo de módulos',
          path: '/platform/catalog',
          icon: 'cube',
          permission: PLATFORM_PERMISSIONS.modulesRead,
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
        {
          label: 'Configurações',
          path: '/platform/settings',
          icon: 'settings',
          permission: PLATFORM_PERMISSIONS.settingsRead,
        },
      ]),
    },
  ]);

  readonly tenantNav = computed<readonly NavGroup[]>(() => {
    const slug = this.tenantContext.tenant()?.slug;
    if (!slug) return [];
    const base = `/t/${slug}`;

    const groups: NavGroup[] = [
      {
        id: 'workspace',
        items: this.visible([
          { label: 'Painel', path: base, icon: 'dashboard', exact: true },
          { label: 'Módulos', path: `${base}/modules`, icon: 'cube' },
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
            label: 'Permissões',
            path: `${base}/permissions`,
            icon: 'shield',
            permission: TENANT_PERMISSIONS.accessRead,
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

    const accessible = this.tenantModules.accessible().filter((r) => r.manifest.showInNavigation);
    for (const group of this.registry.groups) {
      const items = accessible
        .filter((r) => r.manifest.groupId === group.id)
        .map<NavItem>(({ manifest }) => ({
          label: manifest.name,
          path: `${base}/${manifest.basePath}`,
          icon: manifest.icon,
        }));
      if (items.length > 0) groups.push({ id: group.id, label: group.name, items });
    }
    return groups;
  });

  private visible(entries: readonly Entry[]): NavItem[] {
    return entries
      .filter((e) => !e.permission || this.permissions.can(e.permission))
      .map(({ label, path, icon, exact }) => ({ label, path, icon, exact }));
  }
}
