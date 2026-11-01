import { inject, Injectable } from '@angular/core';
import type { Observable } from 'rxjs';
import { ApiService } from '../../../core/api/api.service';

export type RegistryModuleStatus = 'AVAILABLE' | 'DEPRECATED';
export type TenantModuleStatus = 'DISABLED' | 'ENABLING' | 'ENABLED' | 'DISABLING' | 'ERROR';

/** Razões pelas quais uma funcionalidade não está disponível (decididas pelo servidor). */
export type FeatureReason =
  'NOT_LICENSED' | 'FEATURE_NOT_LICENSED' | 'MODULE_DISABLED' | 'FEATURE_OFF';

export interface FeatureDto {
  readonly code: string;
  readonly name: string;
  readonly moduleCode: string;
  readonly enabled: boolean;
  readonly reason: FeatureReason | null;
  readonly override: boolean | null;
  readonly overrideReason: string | null;
  readonly overrideExpiresAt: string | null;
}

export interface ModuleDto {
  readonly code: string;
  readonly name: string;
  readonly kind: 'FOUNDATION' | 'MODULE';
  readonly releaseVersion: string;
  readonly registryStatus: RegistryModuleStatus;
  readonly requires: readonly { code: string; constraint: string; optional: boolean }[];
  /** Licenciado pelo plano contratado (o núcleo está sempre licenciado). */
  readonly licensed: boolean;
  readonly status: TenantModuleStatus;
  readonly enabledAt: string | null;
  readonly lastError: string | null;
  /** Módulos obrigatórios ainda por activar, pela ordem de activação. */
  readonly missingDependencies: readonly string[];
  /** Módulos activos que dependem deste (impedem a desactivação). */
  readonly activeDependents: readonly string[];
  readonly features: readonly FeatureDto[];
}

export interface DisableResult {
  readonly module: ModuleDto;
  readonly affectedFeatures: readonly string[];
}

export interface FeatureOverride {
  /** `null` repõe o valor por omissão. */
  readonly override: boolean | null;
  readonly reason?: string | null;
  readonly expiresAt?: string | null;
}

/** Registo de módulos e funcionalidades do tenant activo (C03). Licença e dependências são do servidor. */
@Injectable({ providedIn: 'root' })
export class ModulesApi {
  private readonly api = inject(ApiService);

  list(): Observable<readonly ModuleDto[]> {
    return this.api.get('modules');
  }

  enable(code: string, withDependencies = false): Observable<ModuleDto> {
    return this.api.post(`tenant/modules/${encodeURIComponent(code)}/enable`, { withDependencies });
  }

  disable(code: string): Observable<DisableResult> {
    return this.api.post(`tenant/modules/${encodeURIComponent(code)}/disable`, {});
  }

  setFeatureOverride(featureCode: string, value: FeatureOverride): Observable<FeatureDto> {
    return this.api.put(`tenant/features/${encodeURIComponent(featureCode)}`, value);
  }
}
