import { inject, Injectable } from '@angular/core';
import type { Observable } from 'rxjs';
import { ApiService } from '../../../core/api/api.service';

export type RuleStatus = 'DRAFT' | 'PUBLISHED' | 'DISABLED';

export interface RuleAction {
  readonly type: 'BLOCK';
  readonly message: string;
  readonly field?: string;
}

export interface RuleDto {
  readonly id: string;
  readonly entityCode: string;
  readonly code: string;
  readonly name: string;
  readonly description: string | null;
  readonly trigger: 'VALIDATE';
  readonly revision: number;
  readonly priority: number;
  readonly conditionAst: unknown;
  readonly actionAst: RuleAction;
  readonly status: RuleStatus;
  readonly effectiveFrom: string | null;
  readonly effectiveTo: string | null;
  readonly publishedAt: string | null;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RuleBody {
  readonly name: string;
  readonly description: string | null;
  readonly priority: number;
  readonly conditionAst: unknown;
  readonly actionAst: RuleAction;
  readonly effectiveFrom: string | null;
  readonly effectiveTo: string | null;
}

export interface SimulationDto {
  readonly result: 'PASS' | 'FAIL' | 'SKIPPED' | 'ERROR';
  readonly message: string | null;
  readonly reason: string | null;
}

export interface EvaluationDto {
  readonly id: string;
  readonly resourceId: string | null;
  readonly result: 'PASS' | 'FAIL' | 'SKIPPED' | 'ERROR';
  readonly errorCode: string | null;
  readonly durationMs: number;
  readonly correlationId: string;
  readonly createdAt: string;
}

const PATH = 'rules';

/** Regras de validação de uma entidade (C12) sobre a API real. O servidor valida, publica e regista. */
@Injectable({ providedIn: 'root' })
export class RulesApi {
  private readonly api = inject(ApiService);

  list(entityCode: string): Observable<readonly RuleDto[]> {
    return this.api.get<readonly RuleDto[]>(PATH, { params: { entityCode } });
  }

  create(entityCode: string, code: string, body: RuleBody): Observable<RuleDto> {
    return this.api.post<RuleDto>(PATH, { entityCode, code, ...body });
  }

  update(id: string, expectedVersion: number, body: RuleBody): Observable<RuleDto> {
    return this.api.patch<RuleDto>(`${PATH}/${id}`, { expectedVersion, ...body });
  }

  createRevision(id: string): Observable<RuleDto> {
    return this.api.post<RuleDto>(`${PATH}/${id}/revisions`, {});
  }

  publish(id: string, expectedVersion: number): Observable<RuleDto> {
    return this.api.post<RuleDto>(`${PATH}/${id}/publish`, { expectedVersion });
  }

  disable(id: string, expectedVersion: number): Observable<RuleDto> {
    return this.api.post<RuleDto>(`${PATH}/${id}/disable`, { expectedVersion });
  }

  simulate(id: string, values: Record<string, unknown>): Observable<SimulationDto> {
    return this.api.post<SimulationDto>(`${PATH}/${id}/simulate`, { values });
  }

  evaluations(id: string): Observable<readonly EvaluationDto[]> {
    return this.api.get<readonly EvaluationDto[]>(`${PATH}/${id}/evaluations`);
  }
}
