import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { catchError, finalize, type Observable, of } from 'rxjs';
import type { ApiError } from '../../../core/api/api-error.model';
import { errorMessage } from '../../../core/api/error-message';
import { entityKeyOf } from '../../../core/dynamic/http/dynamic-mapper';
import { DynamicEntityRegistryService } from '../../../core/dynamic/entity-registry.service';
import { PermissionService } from '../../../core/permissions/permission.service';
import { TenantContextService } from '../../../core/tenant-context/tenant-context.service';
import { Alert } from '../../../shared/ui/alert/alert';
import { Badge } from '../../../shared/ui/badge/badge';
import { Button } from '../../../shared/ui/button/button';
import { Card } from '../../../shared/ui/card/card';
import { Dialog } from '../../../shared/ui/dialog/dialog';
import { EmptyState } from '../../../shared/ui/empty-state/empty-state';
import { Input } from '../../../shared/ui/input/input';
import { LoadingState } from '../../../shared/ui/loading-state/loading-state';
import { PageHeader } from '../../../shared/ui/page-header/page-header';
import { Select, type SelectOption } from '../../../shared/ui/select/select';
import { Table, type TableColumn } from '../../../shared/ui/table/table';
import { Textarea } from '../../../shared/ui/textarea/textarea';
import { IamApi, type MemberDto } from '../../tenant/data-access/iam.api';
import {
  ACTION_LABEL,
  amountLabel,
  memberName,
  parseWorkflowCodes,
  recordPath,
  taskActions,
} from './approvals-model';
import {
  ApprovalsApi,
  type DelegationBody,
  type DelegationDto,
  type TaskAction,
  type TaskViewDto,
} from './workflows.api';

type View = 'pending' | 'decided';
type Step = TaskAction | 'claim';

const COLUMNS: readonly TableColumn[] = [
  { key: 'request', label: 'Pedido' },
  { key: 'requester', label: 'Solicitante' },
  { key: 'stage', label: 'Etapa' },
  { key: 'amount', label: 'Valor', align: 'end' },
  { key: 'due', label: 'Prazo' },
  { key: 'version', label: 'Versão' },
  { key: 'actions', label: '', align: 'end' },
];

const DELEGATION_COLUMNS: readonly TableColumn[] = [
  { key: 'who', label: 'Delegação' },
  { key: 'period', label: 'Período' },
  { key: 'limits', label: 'Limites' },
  { key: 'reason', label: 'Motivo' },
  { key: 'actions', label: '', align: 'end' },
];

interface Pending {
  readonly item: TaskViewDto;
  readonly action: TaskAction;
}

/**
 * Minha caixa de aprovações (C14): o que há por decidir (incluindo por delegação), o que já tratei e as minhas delegações.
 * O servidor decide a quem pertence cada tarefa e o que cada pessoa pode fazer; aqui só se mostra e se pede.
 */
@Component({
  selector: 'app-approvals-page',
  imports: [
    DatePipe,
    FormsModule,
    RouterLink,
    Alert,
    Badge,
    Button,
    Card,
    Dialog,
    EmptyState,
    Input,
    LoadingState,
    PageHeader,
    Select,
    Table,
    Textarea,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    <app-page-header
      title="Aprovações"
      description="Pedidos que aguardam a sua decisão, com o valor, o solicitante, a etapa, o prazo e a versão submetida."
    />

    @if (notice(); as message) {
      <app-alert class="mb-4" tone="success">{{ message }}</app-alert>
    }
    @if (actionError(); as message) {
      <app-alert class="mb-4" tone="danger">{{ message }}</app-alert>
    }

    <div class="mb-4 flex gap-2" role="group" aria-label="Estado das tarefas">
      <app-button
        [variant]="view() === 'pending' ? 'primary' : 'secondary'"
        size="sm"
        (click)="view.set('pending')"
        >Por decidir</app-button
      >
      <app-button
        [variant]="view() === 'decided' ? 'primary' : 'secondary'"
        size="sm"
        (click)="view.set('decided')"
        >Já tratadas</app-button
      >
    </div>

    <app-card [flush]="true">
      @if (tasks.isLoading() && !tasks.hasValue()) {
        <app-loading-state label="A carregar tarefas…" />
      } @else if (tasks.error()) {
        <div class="p-5">
          <app-alert tone="danger" title="Não foi possível carregar a caixa de aprovações">{{
            loadError(tasks.error())
          }}</app-alert>
        </div>
      } @else if (tasks.value(); as list) {
        @if (list.length === 0) {
          <app-empty-state
            icon="check"
            [title]="view() === 'pending' ? 'Nada por decidir' : 'Ainda não tratou nenhuma tarefa'"
          />
        } @else {
          <app-table
            caption="Tarefas de aprovação"
            [columns]="columns"
            [rows]="list"
            data-testid="inbox"
          >
            <ng-template let-row let-column="column">
              @switch (column.key) {
                @case ('request') {
                  <a
                    class="font-medium text-brand-700 hover:underline dark:text-brand-300"
                    [routerLink]="recordLink(row)"
                    >{{ entityName(row.entityCode) }}</a
                  >
                  <span class="block text-xs text-fg-muted">{{ row.workflow.name }}</span>
                }
                @case ('requester') {
                  {{ nameOf(row.submittedByMembershipId) }}
                }
                @case ('stage') {
                  {{ row.stage.label }}
                  <span class="block text-xs text-fg-muted">{{
                    criteria(row.stage.criteria)
                  }}</span>
                }
                @case ('amount') {
                  {{ amount(row) }}
                }
                @case ('due') {
                  @if (row.task.dueAt) {
                    {{ row.task.dueAt | date: 'dd/MM/yyyy HH:mm' }}
                    @if (row.overdue) {
                      <app-badge tone="danger">Em atraso</app-badge>
                    }
                  } @else {
                    —
                  }
                }
                @case ('version') {
                  v{{ row.resourceVersion }}
                  @if (row.delegated) {
                    <app-badge tone="brand">Por delegação</app-badge>
                  }
                }
                @case ('actions') {
                  <span class="flex flex-wrap justify-end gap-1">
                    @for (action of actionsOf(row); track action) {
                      <app-button
                        size="sm"
                        [variant]="action === 'approve' ? 'primary' : 'secondary'"
                        [disabled]="working()"
                        (click)="ask(row, action)"
                        >{{ label(action) }}</app-button
                      >
                    }
                    @if (view() === 'decided') {
                      <app-badge [tone]="row.task.status === 'APPROVED' ? 'success' : 'warning'">{{
                        row.task.status === 'APPROVED'
                          ? 'Aprovada'
                          : row.task.status === 'REJECTED'
                            ? 'Rejeitada'
                            : 'Devolvida'
                      }}</app-badge>
                    }
                  </span>
                }
              }
            </ng-template>
          </app-table>
        }
      }
    </app-card>

    @if (canDelegate()) {
      <div class="mb-3 mt-8 flex items-center justify-between">
        <h2 class="text-base font-semibold">As minhas delegações</h2>
        <app-button size="sm" variant="secondary" (click)="openDelegation()"
          >Nova delegação</app-button
        >
      </div>
      <app-card [flush]="true">
        @if (delegations.isLoading() && !delegations.hasValue()) {
          <app-loading-state label="A carregar delegações…" />
        } @else if (delegations.error()) {
          <div class="p-5">
            <app-alert tone="danger" title="Não foi possível carregar as delegações">{{
              loadError(delegations.error())
            }}</app-alert>
          </div>
        } @else if (delegations.value(); as list) {
          @if (list.length === 0) {
            <app-empty-state icon="users" title="Sem delegações" />
          } @else {
            <app-table
              caption="Delegações de aprovação"
              [columns]="delegationColumns"
              [rows]="list"
              data-testid="delegations"
            >
              <ng-template let-row let-column="column">
                @switch (column.key) {
                  @case ('who') {
                    {{ nameOf(row.fromMembershipId) }} → {{ nameOf(row.toMembershipId) }}
                    @if (row.revokedAt) {
                      <app-badge tone="neutral">Revogada</app-badge>
                    }
                  }
                  @case ('period') {
                    {{ row.validFrom | date: 'dd/MM/yyyy' }} –
                    {{ row.validUntil | date: 'dd/MM/yyyy' }}
                  }
                  @case ('limits') {
                    {{ limits(row) }}
                  }
                  @case ('reason') {
                    {{ row.reason }}
                  }
                  @case ('actions') {
                    @if (mayRevoke(row)) {
                      <app-button size="sm" variant="danger" (click)="revoke(row)"
                        >Revogar</app-button
                      >
                    }
                  }
                }
              </ng-template>
            </app-table>
          }
        }
      </app-card>
    }

    <app-dialog [open]="pending() !== null" [title]="pendingTitle()" (closed)="pending.set(null)">
      @if (pending(); as current) {
        <p>
          {{ entityName(current.item.entityCode) }} de
          <strong>{{ nameOf(current.item.submittedByMembershipId) }}</strong> ({{
            amount(current.item)
          }}, versão {{ current.item.resourceVersion }}).
        </p>
        <div class="mt-3 text-fg">
          <app-textarea
            label="Motivo"
            [required]="current.action !== 'approve'"
            [rows]="3"
            [ngModel]="reason()"
            (ngModelChange)="reason.set($event ?? '')"
          />
        </div>
      }
      <ng-container dialogActions>
        <app-button variant="secondary" (click)="pending.set(null)">Cancelar</app-button>
        <app-button
          [loading]="working()"
          [disabled]="pending()?.action !== 'approve' && !reason().trim()"
          (click)="confirm()"
          >Confirmar</app-button
        >
      </ng-container>
    </app-dialog>

    <app-dialog
      [open]="delegating()"
      title="Nova delegação"
      [wide]="true"
      (closed)="delegating.set(false)"
    >
      <div class="grid gap-3 text-fg">
        @if (memberOptions().length > 0) {
          <app-select
            label="Delegar em"
            [options]="memberOptions()"
            [ngModel]="draft().toMembershipId"
            (ngModelChange)="patch({ toMembershipId: $event ?? '' })"
          />
        } @else {
          <app-input
            label="Identificador do membro"
            hint="Não tem permissão para listar membros: indique o identificador."
            [ngModel]="draft().toMembershipId"
            (ngModelChange)="patch({ toMembershipId: ($event ?? '').toString() })"
          />
        }
        <app-input
          label="Válida até"
          type="datetime-local"
          [ngModel]="draft().validUntil"
          (ngModelChange)="patch({ validUntil: ($event ?? '').toString() })"
        />
        <app-input
          label="Workflows abrangidos"
          hint="Códigos separados por vírgula; vazio = todos."
          [ngModel]="draft().codes"
          (ngModelChange)="patch({ codes: ($event ?? '').toString() })"
        />
        <div class="grid grid-cols-2 gap-3">
          <app-input
            label="Montante máximo"
            hint="Decimal, p. ex. 1000.00; vazio = sem limite."
            [ngModel]="draft().maxAmount"
            (ngModelChange)="patch({ maxAmount: ($event ?? '').toString() })"
          />
          <app-input
            label="Moeda"
            hint="3 letras, p. ex. EUR."
            [ngModel]="draft().currency"
            (ngModelChange)="patch({ currency: ($event ?? '').toString().toUpperCase() })"
          />
        </div>
        <app-textarea
          label="Motivo"
          [required]="true"
          [rows]="2"
          [ngModel]="draft().reason"
          (ngModelChange)="patch({ reason: $event ?? '' })"
        />
        @if (delegationError(); as message) {
          <app-alert tone="danger">{{ message }}</app-alert>
        }
      </div>
      <ng-container dialogActions>
        <app-button variant="secondary" (click)="delegating.set(false)">Cancelar</app-button>
        <app-button [loading]="working()" [disabled]="!draftValid()" (click)="saveDelegation()"
          >Delegar</app-button
        >
      </ng-container>
    </app-dialog>
  `,
})
export class ApprovalsPage {
  private readonly approvals = inject(ApprovalsApi);
  private readonly iam = inject(IamApi);
  private readonly registry = inject(DynamicEntityRegistryService);
  private readonly permissions = inject(PermissionService);
  private readonly tenant = inject(TenantContextService).tenant;

  protected readonly columns = COLUMNS;
  protected readonly delegationColumns = DELEGATION_COLUMNS;
  protected readonly view = signal<View>('pending');
  protected readonly pending = signal<Pending | null>(null);
  protected readonly reason = signal('');
  protected readonly working = signal(false);
  protected readonly notice = signal<string | null>(null);
  protected readonly actionError = signal<string | null>(null);
  private readonly reload = signal(0);

  protected readonly canDelegate = computed(() => this.permissions.can('approval.delegate'));

  protected readonly tasks = rxResource({
    params: () => ({ view: this.view(), reload: this.reload() }),
    stream: ({ params }) => this.approvals.inbox(params.view),
  });

  protected readonly delegations = rxResource({
    params: () => (this.canDelegate() ? { reload: this.reload() } : undefined),
    stream: () => this.approvals.delegations(),
  });

  /** Os membros servem para mostrar nomes; sem permissão para os listar, mostram-se identificadores curtos. */
  private readonly members = rxResource({
    stream: () => this.iam.listMembers().pipe(catchError(() => of([] as readonly MemberDto[]))),
  });
  private readonly memberList = computed(() => this.members.value() ?? []);
  protected readonly memberOptions = computed<readonly SelectOption[]>(() =>
    this.memberList()
      .filter((m) => m.status === 'ACTIVE')
      .map((m) => ({ value: m.id, label: m.displayName ?? m.email ?? m.id })),
  );

  protected readonly delegating = signal(false);
  protected readonly delegationError = signal<string | null>(null);
  protected readonly draft = signal({
    toMembershipId: '',
    validUntil: '',
    codes: '',
    maxAmount: '',
    currency: '',
    reason: '',
  });
  protected readonly draftValid = computed(() => {
    const d = this.draft();
    const limited = d.maxAmount.trim() !== '';
    return (
      d.toMembershipId !== '' &&
      d.validUntil !== '' &&
      d.reason.trim() !== '' &&
      (!limited || /^[A-Z]{3}$/.test(d.currency))
    );
  });

  protected readonly pendingTitle = computed(() => {
    const current = this.pending();
    return current ? ACTION_LABEL[current.action] : '';
  });

  protected label(action: Step): string {
    return ACTION_LABEL[action];
  }

  protected actionsOf(item: TaskViewDto): readonly Step[] {
    return this.view() === 'pending' ? taskActions(item) : [];
  }

  protected amount(item: TaskViewDto): string {
    return amountLabel(item);
  }

  protected criteria(value: string): string {
    return value === 'ALL' ? 'Todos aprovam' : value === 'ANY' ? 'Qualquer um aprova' : 'Quórum';
  }

  protected nameOf(id: string | null): string {
    return memberName(this.memberList(), id);
  }

  protected entityName(code: string): string {
    return this.registry.find(entityKeyOf(code))?.names.singular ?? code;
  }

  protected recordLink(item: TaskViewDto): string[] {
    return recordPath(this.tenant()?.slug ?? '', entityKeyOf(item.entityCode), item.recordId);
  }

  protected loadError(error: unknown): string {
    return errorMessage(error);
  }

  protected limits(row: DelegationDto): string {
    const parts: string[] = [];
    const codes = row.scope.workflowCodes ?? [];
    parts.push(codes.length > 0 ? codes.join(', ') : 'Todos os workflows');
    if (row.maxAmount !== null) parts.push(`até ${row.maxAmount} ${row.currency ?? ''}`.trim());
    return parts.join(' · ');
  }

  protected mayRevoke(row: DelegationDto): boolean {
    return row.revokedAt === null && row.direction === 'GIVEN';
  }

  protected ask(item: TaskViewDto, action: Step): void {
    this.notice.set(null);
    this.actionError.set(null);
    if (action === 'claim') {
      this.run(() => this.approvals.claim(item.task.id), 'Tarefa reclamada.');
      return;
    }
    if (action === 'approve') {
      this.run(() => this.approvals.decide(item.task.id, 'approve', null), 'Aprovado.');
      return;
    }
    this.reason.set('');
    this.pending.set({ item, action });
  }

  protected confirm(): void {
    const current = this.pending();
    if (!current) return;
    const text = this.reason().trim();
    this.run(
      () => this.approvals.decide(current.item.task.id, current.action, text),
      current.action === 'reject' ? 'Pedido rejeitado.' : 'Pedido devolvido a quem o submeteu.',
    );
  }

  protected openDelegation(): void {
    this.delegationError.set(null);
    this.draft.set({
      toMembershipId: '',
      validUntil: '',
      codes: '',
      maxAmount: '',
      currency: '',
      reason: '',
    });
    this.delegating.set(true);
  }

  protected patch(change: Partial<ReturnType<typeof this.draft>>): void {
    this.draft.update((d) => ({ ...d, ...change }));
  }

  protected saveDelegation(): void {
    const d = this.draft();
    const codes = parseWorkflowCodes(d.codes);
    const body: DelegationBody = {
      toMembershipId: d.toMembershipId,
      validUntil: d.validUntil,
      reason: d.reason.trim(),
      ...(codes.length > 0 ? { scope: { workflowCodes: codes } } : {}),
      ...(d.maxAmount.trim() !== '' ? { maxAmount: d.maxAmount.trim(), currency: d.currency } : {}),
    };
    this.working.set(true);
    this.delegationError.set(null);
    this.approvals
      .delegate(body)
      .pipe(finalize(() => this.working.set(false)))
      .subscribe({
        next: () => {
          this.delegating.set(false);
          this.notice.set('Delegação criada.');
          this.reload.update((n) => n + 1);
        },
        error: (error: ApiError) => this.delegationError.set(errorMessage(error)),
      });
  }

  protected revoke(row: DelegationDto): void {
    this.notice.set(null);
    this.actionError.set(null);
    this.run(() => this.approvals.revokeDelegation(row.id, row.version), 'Delegação revogada.');
  }

  private run(call: () => Observable<unknown>, done: string): void {
    this.working.set(true);
    call()
      .pipe(finalize(() => this.working.set(false)))
      .subscribe({
        next: () => {
          this.pending.set(null);
          this.notice.set(done);
          this.reload.update((n) => n + 1);
        },
        error: (error: ApiError) => {
          this.pending.set(null);
          this.actionError.set(errorMessage(error));
          this.reload.update((n) => n + 1);
        },
      });
  }
}
