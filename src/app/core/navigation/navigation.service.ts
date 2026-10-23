import { computed, inject, Injectable } from '@angular/core';
import { EntityAccessService } from '../dynamic/entity-access.service';
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
  private readonly entities = inject(EntityAccessService);

  readonly platformNav = computed<readonly NavGroup[]>(() => [
    {
      id: 'platform',
      items: this.visible([
        { label: 'Painel', path: '/platform', icon: 'dashboard', exact: true },
        {
          label: 'Tenants',
          path: '/platform/tenants',
          icon: 'building',
          permission: PLATFORM_PERMISSIONS.tenantsManage,
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
          permission: PLATFORM_PERMISSIONS.billingManage,
        },
        {
          label: 'Subscrições',
          path: '/platform/subscriptions',
          icon: 'shield',
          permission: PLATFORM_PERMISSIONS.billingManage,
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
          {
            label: 'Módulos',
            path: `${base}/modules`,
            icon: 'cube',
            permission: TENANT_PERMISSIONS.modulesRead,
          },
          {
            label: 'Plano',
            path: `${base}/plan`,
            icon: 'card',
            permission: TENANT_PERMISSIONS.planRead,
          },
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
          {
            label: 'Aprovações',
            path: `${base}/approvals`,
            icon: 'check',
            permission: TENANT_PERMISSIONS.approvalsDecide,
          },
          {
            label: 'Entidades',
            path: `${base}/entities`,
            icon: 'cube',
            permission: TENANT_PERMISSIONS.entitiesRead,
          },
        ]),
      },
    ];

    const entityItems = this.entities.readable().map<NavItem>((entity) => ({
      label: entity.names.plural,
      path: `${base}/data/${entity.key}`,
      icon: entity.icon,
    }));
    if (entityItems.length > 0) groups.push({ id: 'data', label: 'Dados', items: entityItems });

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
