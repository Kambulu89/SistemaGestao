import { inject, Injectable } from '@angular/core';
import type { Observable } from 'rxjs';
import { ApiService } from '../../../core/api/api.service';

export type AutomationStatus = 'DRAFT' | 'ACTIVE' | 'PAUSED';
export type RunStatus = 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'DEAD';

/** Valor de um parâmetro: literal ou referência a um campo do evento (`payload.campo`). */
export type ParamValue = string | number | boolean | { readonly from: string };

export interface ActionDto {
  readonly type: string;
  readonly params: Readonly<Record<string, ParamValue>>;
}

export interface Issue {
  readonly path: string;
  readonly code: string;
  readonly message: string;
}

export interface AutomationDto {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly description: string | null;
  readonly eventType: string | null;
  readonly schedule: string | null;
  readonly timezone: string;
  readonly condition: unknown;
  readonly actions: readonly ActionDto[];
  readonly status: AutomationStatus;
  readonly maxRunsPerPeriod: number;
  readonly runAsMembershipId: string | null;
  readonly activatedAt: string | null;
  readonly nextRunAt: string | null;
  readonly version: number;
  /** O que o servidor verifica agora contra o catálogo (vazio = pode activar-se). */
  readonly issues: readonly Issue[];
}

export interface AutomationBody {
  readonly name: string;
  readonly description: string | null;
  readonly eventType: string | null;
  readonly schedule: string | null;
  readonly timezone: string;
  readonly condition: unknown;
  readonly actions: readonly ActionDto[];
  readonly maxRunsPerPeriod: number;
}

export interface EventDescriptorDto {
  readonly type: string;
  readonly label: string;
  readonly fields: readonly {
    readonly name: string;
    readonly kind: 'text' | 'number' | 'boolean';
  }[];
}

export interface ActionDescriptorDto {
  readonly type: string;
  readonly label: string;
  readonly description: string;
  readonly params: readonly {
    readonly name: string;
    readonly kind: 'text' | 'number' | 'boolean';
    readonly required: boolean;
    readonly description: string;
  }[];
}

export interface CatalogDto {
  readonly events: readonly EventDescriptorDto[];
  readonly actions: readonly ActionDescriptorDto[];
}

export interface SimulationDto {
  readonly conditionPassed: boolean | null;
  readonly conditionError: string | null;
  readonly actions: readonly {
    readonly type: string;
    readonly params: Readonly<Record<string, string | number | boolean>> | null;
    readonly error: string | null;
  }[];
  readonly nextRuns: readonly string[];
}

export interface RunDto {
  readonly id: string;
  readonly automationId: string;
  readonly automationCode: string;
  readonly automationVersion: number;
  readonly status: RunStatus;
  readonly attempts: number;
  readonly nextAttemptAt: string;
  readonly depth: number;
  readonly progress: number;
  readonly error: string | null;
  readonly errorCode: string | null;
  readonly scheduledFor: string | null;
  readonly createdAt: string;
  readonly finishedAt: string | null;
  readonly retriedAt: string | null;
  readonly version: number;
}

/** Automações (C15) sobre a API real. O servidor valida, activa em nome de quem activa e executa. */
@Injectable({ providedIn: 'root' })
export class AutomationsApi {
  private readonly api = inject(ApiService);

  catalog(): Observable<CatalogDto> {
    return this.api.get<CatalogDto>('automations/catalog');
  }

  list(): Observable<readonly AutomationDto[]> {
    return this.api.get<readonly AutomationDto[]>('automations');
  }

  create(code: string, body: AutomationBody): Observable<AutomationDto> {
    return this.api.post<AutomationDto>('automations', { code, ...body });
  }

  update(id: string, expectedVersion: number, body: AutomationBody): Observable<AutomationDto> {
    return this.api.patch<AutomationDto>(`automations/${id}`, { expectedVersion, ...body });
  }

  activate(id: string, expectedVersion: number): Observable<AutomationDto> {
    return this.api.post<AutomationDto>(`automations/${id}/activate`, { expectedVersion });
  }

  pause(id: string, expectedVersion: number): Observable<AutomationDto> {
    return this.api.post<AutomationDto>(`automations/${id}/pause`, { expectedVersion });
  }

  simulate(id: string, payload: Record<string, unknown>): Observable<SimulationDto> {
    return this.api.post<SimulationDto>(`automations/${id}/simulate`, { payload });
  }

  runs(automationId?: string): Observable<readonly RunDto[]> {
    return this.api.get<readonly RunDto[]>('automation-runs', {
      params: automationId ? { automationId } : {},
    });
  }

  retry(runId: string, expectedVersion: number): Observable<RunDto> {
    return this.api.post<RunDto>(`automation-runs/${runId}/retry`, { expectedVersion });
  }
}
