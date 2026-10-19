import { computed, inject, Injectable } from '@angular/core';
import { FeatureFlagService } from '../config/feature-flag.service';
import { PermissionService } from '../permissions/permission.service';
import { TenantContextService } from '../tenant-context/tenant-context.service';
import type { ModuleSettingValue, TenantModule } from '../tenant-context/tenant.model';
import {
  type FeatureAccessStatus,
  type ModuleAccessContext,
  type ModuleAccessStatus,
  resolveFeatureAccess,
  resolveModuleAccess,
} from './module-access';
import { ModuleRegistryService } from './module-registry.service';
import type { ModuleManifest } from './module.model';

export interface ResolvedModule {
  readonly manifest: ModuleManifest;
  readonly access: ModuleAccessStatus;
  /** Incluído na subscrição do tenant. */
  readonly contracted: boolean;
  /** Activado pelo tenant. */
  readonly active: boolean;
  readonly tenantModule: TenantModule | undefined;
}

/**
 * Resolve o catálogo para o tenant e utilizador activos. Aqui se distingue
 * módulo contratado, activado e autorizado.
 */
@Injectable({ providedIn: 'root' })
export class TenantModulesService {
  private readonly registry = inject(ModuleRegistryService);
  private readonly tenantContext = inject(TenantContextService);
  private readonly permissions = inject(PermissionService);
  private readonly flags = inject(FeatureFlagService);

  private readonly context = computed<ModuleAccessContext>(() => {
    const active = this.tenantContext.active();
    return {
      subscription: active?.subscription ?? null,
      tenantModules: active?.modules ?? [],
      manifestOf: (id) => this.registry.find(id),
      isFlagEnabled: (f) => this.flags.isEnabled(f),
      can: (p) => this.permissions.can(p),
    };
  });

  /** Módulos contratáveis do catálogo e o seu estado neste tenant. */
  readonly resolved = computed<readonly ResolvedModule[]>(() => {
    const context = this.context();
    return this.registry.modules
      .filter((m) => m.kind === 'module')
      .map((manifest) => {
        const tenantModule = context.tenantModules.find((t) => t.moduleId === manifest.id);
        return {
          manifest,
          access: resolveModuleAccess(manifest, context),
          contracted: context.subscription?.moduleIds.includes(manifest.id) ?? false,
          active: tenantModule?.active ?? false,
          tenantModule,
        };
      });
  });

  /** Módulos que o utilizador pode usar: base do menu lateral. */
  readonly accessible = computed(() => this.resolved().filter((m) => m.access === 'accessible'));

  /**
   * O módulo está contratado, activo e liberto de dependências/flags neste tenant, independentemente
   * de o utilizador ter a permissão de entrada. Serve a quem tem permissões mais finas (ex.: entidades).
   */
  isAvailable(moduleId: string): boolean {
    const access = this.accessOf(moduleId);
    return access === 'accessible' || access === 'forbidden';
  }

  accessOf(moduleId: string): ModuleAccessStatus | null {
    return this.resolved().find((m) => m.manifest.id === moduleId)?.access ?? null;
  }

  featureStatus(moduleId: string, featureId: string): FeatureAccessStatus {
    const resolved = this.resolved().find((m) => m.manifest.id === moduleId);
    const feature = resolved?.manifest.features.find((f) => f.id === featureId);
    if (!resolved || !feature) return 'module-unavailable';
    return resolveFeatureAccess(feature, resolved.access, resolved.tenantModule, this.context());
  }

  /** Valor configurado pelo tenant, ou o valor por omissão do manifesto. */
  settingValue(moduleId: string, key: string): ModuleSettingValue | undefined {
    const resolved = this.resolved().find((m) => m.manifest.id === moduleId);
    return (
      resolved?.tenantModule?.settings[key] ??
      resolved?.manifest.settings.find((s) => s.key === key)?.defaultValue
    );
  }
}
