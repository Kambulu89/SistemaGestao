import { inject, Injectable } from '@angular/core';
import type { PermissionDefinition } from '../permissions/permission.model';
import { MODULE_GROUPS } from './catalog/module-groups';
import { validateCatalog } from './catalog-validation';
import { MODULE_MANIFESTS } from './module-manifests.token';
import type { ModuleGroup, ModuleManifest } from './module.model';

export interface CatalogPermission extends PermissionDefinition {
  readonly moduleId: string;
}

/**
 * Registo central e estático de grupos e módulos (o catálogo). Não sabe nada de tenants:
 * a resolução para um tenant é feita por `TenantModulesService`.
 */
@Injectable({ providedIn: 'root' })
export class ModuleRegistryService {
  readonly groups: readonly ModuleGroup[] = [...MODULE_GROUPS].sort((a, b) => a.order - b.order);

  /** Ordenados por grupo e depois por `order` (a ordem de declaração desempata). */
  readonly modules: readonly ModuleManifest[];

  /** Problemas de integridade do catálogo; vazio quando está tudo coerente. */
  readonly issues: readonly string[];

  private readonly byId: ReadonlyMap<string, ModuleManifest>;

  constructor() {
    const manifests = inject(MODULE_MANIFESTS);
    const groupOrder = new Map(this.groups.map((g) => [g.id, g.order]));

    this.modules = manifests
      .map((manifest, index) => ({ manifest, index }))
      .sort(
        (a, b) =>
          (groupOrder.get(a.manifest.groupId) ?? 0) - (groupOrder.get(b.manifest.groupId) ?? 0) ||
          a.manifest.order - b.manifest.order ||
          a.index - b.index,
      )
      .map(({ manifest }) => manifest);

    this.byId = new Map(this.modules.map((m) => [m.id, m]));
    this.issues = validateCatalog(this.groups, manifests);
    if (this.issues.length > 0) {
      console.error('Catálogo de módulos inválido:\n' + this.issues.join('\n'));
    }
  }

  find(moduleId: string): ModuleManifest | undefined {
    return this.byId.get(moduleId);
  }

  inGroup(groupId: string): readonly ModuleManifest[] {
    return this.modules.filter((m) => m.groupId === groupId);
  }

  /** Todas as permissões declaradas pelo catálogo, para ecrãs de gestão de perfis. */
  permissionCatalog(): readonly CatalogPermission[] {
    return this.modules.flatMap((m) => m.permissions.map((p) => ({ ...p, moduleId: m.id })));
  }
}
