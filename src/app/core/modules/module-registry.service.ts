import { computed, inject, Injectable, signal } from '@angular/core';
import { type Observable, of, tap } from 'rxjs';
import { FeatureFlagService } from '../config/feature-flag.service';
import { PermissionService } from '../permissions/permission.service';
import { TenantContextService } from '../tenant-context/tenant-context.service';
import { ModuleCatalogGateway } from './module-catalog.gateway';
import { resolveModuleAccess } from './module-access';
import type { ModuleAccessStatus, ModuleManifest, ResolvedModule } from './module.model';

/** Catálogo de módulos e a sua resolução para o tenant activo. */
@Injectable({ providedIn: 'root' })
export class ModuleRegistryService {
  private readonly gateway = inject(ModuleCatalogGateway);
  private readonly tenantContext = inject(TenantContextService);
  private readonly permissions = inject(PermissionService);
  private readonly flags = inject(FeatureFlagService);

  private readonly _catalog = signal<readonly ModuleManifest[] | null>(null);

  readonly catalog = computed(() => this._catalog() ?? []);

  /** Todos os módulos do catálogo com o respectivo estado de acesso no tenant activo. */
  readonly resolved = computed<readonly ResolvedModule[]>(() => {
    const tenantModules = this.tenantContext.active()?.modules ?? [];
    return this.catalog().map((manifest) => ({
      manifest,
      access: resolveModuleAccess(manifest, {
        tenantModules,
        isFlagEnabled: (f) => this.flags.isEnabled(f),
        can: (p) => this.permissions.can(p),
      }),
    }));
  });

  readonly accessible = computed(() => this.resolved().filter((m) => m.access === 'accessible'));

  ensureCatalog(): Observable<readonly ModuleManifest[]> {
    const cached = this._catalog();
    if (cached) return of(cached);
    return this.gateway.loadCatalog().pipe(tap((list) => this._catalog.set(list)));
  }

  find(moduleId: string): ModuleManifest | undefined {
    return this.catalog().find((m) => m.id === moduleId);
  }

  accessOf(moduleId: string): ModuleAccessStatus | null {
    return this.resolved().find((m) => m.manifest.id === moduleId)?.access ?? null;
  }
}
