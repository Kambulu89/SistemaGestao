import { inject, Injectable } from '@angular/core';
import type { Observable } from 'rxjs';
import { ApiService } from '../../../core/api/api.service';

export type WorkflowStatus = 'DRAFT' | 'PUBLISHED' | 'RETIRED';
export type Criteria = 'ALL' | 'ANY' | 'QUORUM';
export type ApproverType = 'MEMBERSHIP' | 'ROLE';

export interface ApproverDto {
  readonly type: ApproverType;
  readonly id: string;
}

export interface StageDto {
  readonly code: string;
  readonly label: string;
  /** Condição (AST das políticas de acesso) sobre o registo congelado; dispensa a etapa quando é falsa. */
  readonly condition?: unknown;
  readonly approvers: readonly ApproverDto[];
  readonly criteria: Criteria;
  readonly quorum?: number;
  readonly dueInHours?: number;
  readonly allowSelfApproval: boolean;
}

export interface GraphDto {
  readonly stages: readonly StageDto[];
  readonly amountField?: string;
  readonly currencyField?: string;
}

export interface Issue {
  readonly path: string;
  readonly code: string;
  readonly message: string;
}

export interface WorkflowDto {
  readonly id: string;
  readonly entityCode: string;
  readonly code: string;
  readonly name: string;
  readonly description: string | null;
  readonly revision: number;
  readonly version: number;
  readonly status: WorkflowStatus;
  readonly graph: GraphDto;
  /** Problemas que o servidor verifica agora (só nas publicadas; vazio = utilizável). */
  readonly issues: readonly Issue[];
}

export interface WorkflowBody {
  readonly name: string;
  readonly description: string | null;
  readonly graph: GraphDto;
}

export interface WorkflowPreviewDto {
  readonly issues: readonly Issue[];
  readonly publishable: boolean;
}

/** Workflow publicado, tal como o vê quem submete (sem os responsáveis). */
export interface SubmittableWorkflowDto {
  readonly code: string;
  readonly name: string;
  readonly revision: number;
  readonly stages: readonly { readonly code: string; readonly label: string }[];
}

export type InstanceStatus =
  'RUNNING' | 'WAITING' | 'APPROVED' | 'REJECTED' | 'CANCELLED' | 'FAILED';
export type TaskStatus = 'OPEN' | 'CLAIMED' | 'APPROVED' | 'REJECTED' | 'RETURNED' | 'CANCELLED';

export interface InstanceDto {
  readonly id: string;
  readonly workflowCode: string;
  readonly workflowName: string;
  readonly workflowRevision: number;
  readonly entityCode: string;
  readonly recordId: string;
  readonly resourceVersion: number;
  readonly status: InstanceStatus;
  readonly endReason: string | null;
  readonly currentStageIndex: number;
  readonly submittedByMembershipId: string;
  readonly startedAt: string;
  readonly endedAt: string | null;
}

export interface TaskDto {
  readonly id: string;
  readonly instanceId: string;
  readonly stageCode: string;
  readonly stageIndex: number;
  readonly assigneeMembershipId: string | null;
  readonly candidateRoleId: string | null;
  readonly status: TaskStatus;
  readonly dueAt: string | null;
  readonly decidedByMembershipId: string | null;
  readonly decisionReason: string | null;
  readonly decidedAt: string | null;
}

export interface InstanceDetailDto {
  readonly instance: InstanceDto;
  readonly tasks: readonly TaskDto[];
}

/** Uma tarefa tal como a caixa de aprovações a mostra. */
export interface TaskViewDto {
  readonly task: TaskDto;
  readonly workflow: { readonly code: string; readonly name: string; readonly revision: number };
  readonly entityCode: string;
  readonly recordId: string;
  readonly resourceVersion: number;
  readonly submittedByMembershipId: string;
  readonly stage: { readonly code: string; readonly label: string; readonly criteria: Criteria };
  readonly amount: string | null;
  readonly currency: string | null;
  readonly overdue: boolean;
  readonly can: { readonly claim: boolean; readonly decide: boolean };
  readonly delegated: boolean;
}

export interface DelegationDto {
  readonly id: string;
  readonly fromMembershipId: string;
  readonly toMembershipId: string;
  readonly validFrom: string;
  readonly validUntil: string;
  readonly scope: { readonly workflowCodes?: readonly string[] };
  readonly maxAmount: string | null;
  readonly currency: string | null;
  readonly reason: string;
  readonly revokedAt: string | null;
  readonly version: number;
  /** `GIVEN`: delegada por mim; `RECEIVED`: recebida (só nas listagens). */
  readonly direction?: 'GIVEN' | 'RECEIVED';
}

export interface DelegationBody {
  readonly toMembershipId: string;
  readonly validUntil: string;
  readonly scope?: { readonly workflowCodes: readonly string[] };
  readonly maxAmount?: string;
  readonly currency?: string;
  readonly reason: string;
}

export type TaskAction = 'approve' | 'reject' | 'return';

/** Definições de workflow (C14) sobre a API real. O servidor valida, verifica e publica. */
@Injectable({ providedIn: 'root' })
export class WorkflowsApi {
  private readonly api = inject(ApiService);

  list(entityCode: string): Observable<readonly WorkflowDto[]> {
    return this.api.get<readonly WorkflowDto[]>('workflows', { params: { entityCode } });
  }

  create(entityCode: string, code: string, body: WorkflowBody): Observable<WorkflowDto> {
    return this.api.post<WorkflowDto>('workflows', { entityCode, code, ...body });
  }

  update(id: string, expectedVersion: number, body: WorkflowBody): Observable<WorkflowDto> {
    return this.api.patch<WorkflowDto>(`workflows/${id}`, { expectedVersion, ...body });
  }

  createRevision(id: string): Observable<WorkflowDto> {
    return this.api.post<WorkflowDto>(`workflows/${id}/revisions`, {});
  }

  preview(id: string): Observable<WorkflowPreviewDto> {
    return this.api.post<WorkflowPreviewDto>(`workflows/${id}/preview`, {});
  }

  publish(id: string, expectedVersion: number): Observable<WorkflowDto> {
    return this.api.post<WorkflowDto>(`workflows/${id}/publish`, { expectedVersion });
  }

  retire(id: string, expectedVersion: number): Observable<WorkflowDto> {
    return this.api.post<WorkflowDto>(`workflows/${id}/retire`, { expectedVersion });
  }
}

/** Processos, caixa de aprovações e delegações (C14). */
@Injectable({ providedIn: 'root' })
export class ApprovalsApi {
  private readonly api = inject(ApiService);

  submittable(entityCode: string): Observable<readonly SubmittableWorkflowDto[]> {
    return this.api.get<readonly SubmittableWorkflowDto[]>(`dynamic/${entityCode}/workflows`);
  }

  submit(
    entityCode: string,
    workflowCode: string,
    recordId: string,
  ): Observable<InstanceDetailDto> {
    return this.api.post<InstanceDetailDto>('workflow-instances', {
      entityCode,
      workflowCode,
      recordId,
    });
  }

  instancesOf(entityCode: string, recordId: string): Observable<readonly InstanceDto[]> {
    return this.api.get<readonly InstanceDto[]>(
      `dynamic/${entityCode}/records/${recordId}/workflow-instances`,
    );
  }

  instance(id: string): Observable<InstanceDetailDto> {
    return this.api.get<InstanceDetailDto>(`workflow-instances/${id}`);
  }

  cancel(id: string): Observable<InstanceDetailDto> {
    return this.api.post<InstanceDetailDto>(`workflow-instances/${id}/cancel`, {});
  }

  inbox(view: 'pending' | 'decided'): Observable<readonly TaskViewDto[]> {
    return this.api.get<readonly TaskViewDto[]>('approval-tasks', { params: { view } });
  }

  claim(taskId: string): Observable<TaskViewDto> {
    return this.api.post<TaskViewDto>(`approval-tasks/${taskId}/claim`, {});
  }

  decide(
    taskId: string,
    action: TaskAction,
    reason: string | null,
  ): Observable<TaskViewDto & { readonly idempotent: boolean }> {
    return this.api.post<TaskViewDto & { readonly idempotent: boolean }>(
      `approval-tasks/${taskId}/${action}`,
      { reason },
    );
  }

  delegations(): Observable<readonly DelegationDto[]> {
    return this.api.get<readonly DelegationDto[]>('approval-delegations');
  }

  delegate(body: DelegationBody): Observable<DelegationDto> {
    return this.api.post<DelegationDto>('approval-delegations', body);
  }

  revokeDelegation(id: string, expectedVersion: number): Observable<DelegationDto> {
    return this.api.post<DelegationDto>(`approval-delegations/${id}/revoke`, { expectedVersion });
  }
}
