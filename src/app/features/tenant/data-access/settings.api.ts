import { inject, Injectable } from '@angular/core';
import type { Observable } from 'rxjs';
import { ApiService } from '../../../core/api/api.service';

export type SettingScope = 'TENANT' | 'ORGANIZATION' | 'BRANCH' | 'MODULE' | 'MEMBERSHIP';
export type SettingValue = boolean | number | string;

export type ValueSpec =
  | { readonly type: 'boolean' }
  | { readonly type: 'integer'; readonly min?: number; readonly max?: number }
  | { readonly type: 'string'; readonly maxLength: number }
  | { readonly type: 'enum'; readonly options: readonly string[] };

export interface EffectiveSettingDto {
  readonly key: string;
  readonly category: 'PRESENTATION' | 'FISCAL';
  readonly description: string;
  /** Tipo e opções permitidas, definidos pelo servidor. */
  readonly spec: ValueSpec;
  readonly value: SettingValue;
  /** De onde vem o valor: `DEFAULT` ou o âmbito mais específico que o define (com a sua versão). */
  readonly source: {
    readonly level: 'DEFAULT' | SettingScope;
    readonly scopeId?: string | null;
    readonly moduleCode?: string | null;
    readonly version?: number;
  };
  readonly allowedScopes: readonly SettingScope[];
}

export interface StoredSettingDto {
  readonly key: string;
  readonly scopeType: SettingScope;
  readonly scopeId: string | null;
  readonly moduleCode: string | null;
  readonly value: SettingValue;
  readonly version: number;
}

export interface ScopeRef {
  readonly scopeType: Exclude<SettingScope, 'MEMBERSHIP'>;
  readonly scopeId?: string | null;
  readonly moduleCode?: string | null;
}

export interface TaxRateDto {
  readonly id: string;
  readonly organizationId: string;
  readonly code: string;
  readonly name: string;
  /** Percentagem como decimal em string. */
  readonly rate: string;
  readonly validFrom: string;
  readonly validTo: string | null;
  readonly category: string;
  readonly exemptionReason: string | null;
  readonly version: number;
}

export interface NewTaxRate {
  readonly organizationId: string;
  readonly code: string;
  readonly name: string;
  readonly rate: string;
  readonly validFrom: string;
  readonly validTo?: string | null;
  readonly category: string;
  readonly exemptionReason?: string | null;
}

export interface UnitDto {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly dimension: string;
  readonly precision: number;
  readonly baseUnitId: string | null;
  readonly factor: string | null;
  readonly version: number;
}

export interface NewUnit {
  readonly code: string;
  readonly name: string;
  readonly dimension: string;
  readonly precision: number;
  readonly baseUnitId?: string | null;
  readonly conversionFactor?: string | null;
}

export interface ConversionDto {
  readonly from: string;
  readonly to: string;
  readonly quantity: string;
  readonly result: string;
}

export interface SequenceDto {
  readonly id: string;
  readonly organizationId: string;
  readonly branchId: string | null;
  readonly documentType: string;
  readonly series: string;
  readonly period: string;
  readonly prefixTemplate: string;
  /** Próximo número a emitir (inteiro como string). */
  readonly nextValue: string;
  readonly padding: number;
  readonly version: number;
}

export interface NewSequence {
  readonly organizationId: string;
  readonly branchId?: string | null;
  readonly documentType: string;
  readonly series: string;
  readonly period?: string;
  readonly prefixTemplate: string;
  readonly nextValue?: string;
  readonly padding?: number;
}

export interface SequencePreviewRequest {
  readonly organizationId: string;
  readonly branchId?: string | null;
  readonly series: string;
  readonly prefixTemplate: string;
  readonly padding?: number;
  readonly nextValue?: string;
  readonly date?: string;
}

/** Configurações, impostos, unidades e sequências do tenant activo (C09). Regras e permissões são do servidor. */
@Injectable({ providedIn: 'root' })
export class SettingsApi {
  private readonly api = inject(ApiService);

  effective(
    query: { organizationId?: string; branchId?: string; moduleCode?: string } = {},
  ): Observable<readonly EffectiveSettingDto[]> {
    return this.api.get('settings/effective', { params: { ...query } });
  }

  listValues(): Observable<readonly StoredSettingDto[]> {
    return this.api.get('settings');
  }

  setValue(
    key: string,
    scope: ScopeRef,
    value: SettingValue,
    expectedVersion?: number,
  ): Observable<StoredSettingDto> {
    return this.api.put(`settings/${encodeURIComponent(key)}`, {
      scopeType: scope.scopeType,
      scopeId: scope.scopeId ?? null,
      moduleCode: scope.moduleCode ?? null,
      value,
      expectedVersion,
    });
  }

  /** Repõe a herança: remove o valor do âmbito. */
  resetValue(key: string, scope: ScopeRef): Observable<void> {
    const params: Record<string, string> = { scopeType: scope.scopeType };
    if (scope.scopeId) params['scopeId'] = scope.scopeId;
    if (scope.moduleCode) params['moduleCode'] = scope.moduleCode;
    return this.api.delete(`settings/${encodeURIComponent(key)}`, { params });
  }

  setPersonal(
    key: string,
    value: SettingValue,
    expectedVersion?: number,
  ): Observable<StoredSettingDto> {
    return this.api.put(`me/settings/${encodeURIComponent(key)}`, { value, expectedVersion });
  }

  resetPersonal(key: string): Observable<void> {
    return this.api.delete(`me/settings/${encodeURIComponent(key)}`);
  }

  listTaxRates(filter: { organizationId?: string; code?: string; on?: string } = {}) {
    return this.api.get<readonly TaxRateDto[]>('tax-rates', { params: { ...filter } });
  }

  createTaxRate(body: NewTaxRate): Observable<TaxRateDto> {
    return this.api.post('tax-rates', body);
  }

  updateTaxRate(
    id: string,
    body: {
      expectedVersion: number;
      name?: string;
      validTo?: string | null;
      category?: string;
      exemptionReason?: string | null;
    },
  ): Observable<TaxRateDto> {
    return this.api.patch(`tax-rates/${id}`, body);
  }

  listUnits(): Observable<readonly UnitDto[]> {
    return this.api.get('units');
  }

  createUnit(body: NewUnit): Observable<UnitDto> {
    return this.api.post('units', body);
  }

  updateUnit(
    id: string,
    body: { expectedVersion: number; name?: string; precision?: number },
  ): Observable<UnitDto> {
    return this.api.patch(`units/${id}`, body);
  }

  convert(from: string, to: string, quantity: string): Observable<ConversionDto> {
    return this.api.get('units/convert', { params: { from, to, quantity } });
  }

  listSequences(filter: { organizationId?: string } = {}): Observable<readonly SequenceDto[]> {
    return this.api.get('sequences', { params: { ...filter } });
  }

  createSequence(body: NewSequence): Observable<SequenceDto> {
    return this.api.post('sequences', body);
  }

  updateSequence(
    id: string,
    body: {
      expectedVersion: number;
      prefixTemplate?: string;
      padding?: number;
      nextValue?: string;
    },
  ): Observable<SequenceDto> {
    return this.api.patch(`sequences/${id}`, body);
  }

  /** Pré-visualização do número, sem o consumir. */
  previewSequence(body: SequencePreviewRequest): Observable<{ example: string }> {
    return this.api.post('sequences/preview', body);
  }
}
