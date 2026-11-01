import { inject, Injectable } from '@angular/core';
import type { Observable } from 'rxjs';
import { ApiService } from '../../../core/api/api.service';

export type StateCategory = 'INITIAL' | 'ACTIVE' | 'FINAL' | 'CANCELLED';
export type MachineStatus = 'DRAFT' | 'PUBLISHED' | 'RETIRED';

export interface StateDto {
  readonly code: string;
  readonly label: string;
  readonly category: StateCategory;
  readonly editable: boolean;
  readonly color?: string;
}

export interface TransitionDto {
  readonly code: string;
  readonly label: string;
  readonly from: readonly string[];
  readonly to: string;
  readonly permission?: string;
  /** Condição (AST das políticas de acesso) sobre os dados actuais do registo. */
  readonly guard?: unknown;
  readonly reasonRequired: boolean;
}

export interface MachineDto {
  readonly id: string;
  readonly entityCode: string;
  readonly code: string;
  readonly name: string;
  readonly description: string | null;
  readonly revision: number;
  readonly version: number;
  readonly status: MachineStatus;
  readonly states: readonly StateDto[];
  readonly transitions: readonly TransitionDto[];
  readonly initialStateCode: string;
  /** Problemas que o servidor verifica agora contra a entidade (só nas publicadas; vazio = utilizável). */
  readonly issues: readonly {
    readonly path: string;
    readonly code: string;
    readonly message: string;
  }[];
}

export interface MachineBody {
  readonly name: string;
  readonly description: string | null;
  readonly states: readonly StateDto[];
  readonly transitions: readonly TransitionDto[];
}

export interface MachinePreviewDto {
  readonly issues: readonly {
    readonly path: string;
    readonly code: string;
    readonly message: string;
  }[];
  readonly publishable: boolean;
}

const PATH = 'state-machines';

/** Máquinas de estados de uma entidade (C13) sobre a API real. O servidor valida, verifica e publica. */
@Injectable({ providedIn: 'root' })
export class StatesApi {
  private readonly api = inject(ApiService);

  list(entityCode: string): Observable<readonly MachineDto[]> {
    return this.api.get<readonly MachineDto[]>(PATH, { params: { entityCode } });
  }

  create(entityCode: string, code: string, body: MachineBody): Observable<MachineDto> {
    return this.api.post<MachineDto>(PATH, { entityCode, code, ...body });
  }

  update(id: string, expectedVersion: number, body: MachineBody): Observable<MachineDto> {
    return this.api.patch<MachineDto>(`${PATH}/${id}`, { expectedVersion, ...body });
  }

  createRevision(id: string): Observable<MachineDto> {
    return this.api.post<MachineDto>(`${PATH}/${id}/revisions`, {});
  }

  preview(id: string): Observable<MachinePreviewDto> {
    return this.api.post<MachinePreviewDto>(`${PATH}/${id}/preview`, {});
  }

  publish(id: string, expectedVersion: number): Observable<MachineDto> {
    return this.api.post<MachineDto>(`${PATH}/${id}/publish`, { expectedVersion });
  }

  retire(id: string, expectedVersion: number): Observable<MachineDto> {
    return this.api.post<MachineDto>(`${PATH}/${id}/retire`, { expectedVersion });
  }
}
