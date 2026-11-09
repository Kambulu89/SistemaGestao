import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { Api, ApiError } from '../core/api';
import { Breadcrumbs } from '../core/breadcrumbs';
import { Workspace } from '../core/workspace';
import { Attachments } from '../ui/attachments';
import { ConfirmService } from '../ui/confirm';
import { CellDef, type Column, DataTable } from '../ui/data-table';
import { formatDate } from '../ui/dates';
import { FieldList } from '../ui/detail-drawer';
import { ErrorAlert } from '../ui/error-alert';
import { FieldControl, FormField } from '../ui/form-field';
import { Action } from '../ui/load';
import { Modal } from '../ui/modal';
import { formatMoney, MoneyInput } from '../ui/money-input';
import { PageDetail } from '../ui/page-detail';
import { ErrorState, Skeleton } from '../ui/states';
import { ToastService } from '../ui/toasts';
import type { PayComponent } from './compensation-model';
import { monthName, RUN_STATUS, type RunStatus } from './payroll-model';
import {
  emptyTerminationForm,
  TerminationFields,
  type TerminationForm,
  terminationPayload,
} from './termination-fields';
import {
  checklistProgress,
  INITIATIVE,
  isEarning,
  lineAmount,
  nextStep,
  serviceLabel,
  SETTLEMENT_KIND,
  type SettlementKind,
  type SettlementLine,
  TASK_CATEGORY,
  TASK_STATUS,
  type TaskStatus,
  taskTone,
  type Termination,
  TERMINATION_REASON,
  TERMINATION_STATUS,
  type TerminationTask,
  terminationTone,
} from './termination-model';

interface LineForm {
  id: string | null;
  kind: SettlementKind;
  componentId: string;
  description: string;
  quantity: string;
  rate: string;
  amount: string | null;
  basis: string;
}

/**
 * Cessação: motivo e aviso, liquidação final (linhas com componente e fundamentação), apoio ao cálculo (sugestões,
 * nunca valores legais), aprovação segregada, lote de liquidação, checklist de saída e documentos.
 */
@Component({
  selector: 'app-termination',
  imports: [
    FormsModule,
    RouterLink,
    PageDetail,
    FieldList,
    Attachments,
    DataTable,
    CellDef,
    Modal,
    FormField,
    FieldControl,
    MoneyInput,
    ErrorAlert,
    ErrorState,
    Skeleton,
    TerminationFields,
  ],
  template: `
    @if (loadError()) {
      <app-error-state [error]="loadError()" (retry)="reload()" />
    } @else if (!t()) {
      <div class="card"><app-skeleton /></div>
    } @else {
      @let x = t()!;
      <app-page-detail
        [title]="'Cessação ' + x.code"
        [subtitle]="x.employee.fullName + ' · ' + reason(x)"
      >
        <ng-container actions>
          <a class="btn-secondary" [routerLink]="['/rh/colaboradores', x.employee.id]"
            >Ver colaborador</a
          >
          @if (x.access?.edit) {
            <button type="button" class="btn-secondary" data-testid="tm-edit" (click)="openEdit()">
              Editar
            </button>
            <button type="button" class="btn-primary" data-testid="tm-submit" (click)="submit()">
              Submeter para aprovação
            </button>
          }
          @if (x.access?.approve) {
            <button
              type="button"
              class="btn-secondary"
              data-testid="tm-return"
              (click)="openDecision(false)"
            >
              Devolver
            </button>
            <button
              type="button"
              class="btn-primary"
              data-testid="tm-approve"
              (click)="openDecision(true)"
            >
              Aprovar
            </button>
          }
          @if (x.access?.settle && canGenerate()) {
            <button
              type="button"
              class="btn-primary"
              data-testid="tm-settlement"
              (click)="settlement()"
            >
              Gerar lote da liquidação
            </button>
          }
          @if (x.access?.settle) {
            <button
              type="button"
              class="btn-secondary"
              data-testid="tm-complete"
              (click)="complete()"
            >
              Concluir
            </button>
          }
          @if (x.access?.manage && (x.status === 'DRAFT' || x.status === 'PENDING_APPROVAL')) {
            <button
              type="button"
              class="btn-secondary"
              data-testid="tm-cancel"
              (click)="openCancel()"
            >
              Cancelar processo
            </button>
          }
        </ng-container>

        <div class="mb-4 rounded-card bg-info-soft p-3 text-sm text-info-text" role="status">
          <span class="font-medium">Próximo passo:</span>&nbsp;<span data-testid="tm-next">{{
            next()
          }}</span>
        </div>
        @if (x.blockers?.length) {
          <section
            class="mb-4 rounded-card bg-warning-soft p-3 text-sm text-warning-text"
            aria-labelledby="tm-blockers"
            data-testid="tm-blockers"
          >
            <h2 id="tm-blockers" class="mb-1 font-semibold">Impedimentos à aprovação</h2>
            <ul class="list-disc pl-5">
              @for (b of x.blockers; track b.code) {
                <li>{{ b.message }}</li>
              }
            </ul>
          </section>
        }
        @if (x.decisionNote && x.status === 'DRAFT') {
          <p class="mb-4 rounded-card bg-surface-2 p-3 text-sm" role="note">
            <span class="font-medium">Devolvido:</span> {{ x.decisionNote }}
          </p>
        }

        <section class="card" aria-labelledby="tm-data">
          <h2 id="tm-data" class="mb-3 flex items-center gap-2 font-semibold">
            Cessação
            <span class="badge" [class]="tone(x.status)" data-testid="tm-status">{{
              status(x)
            }}</span>
          </h2>
          <p class="mb-3 text-sm whitespace-pre-line">{{ x.details }}</p>
          <app-field-list
            [fields]="[
              { label: 'Motivo', value: reason(x) },
              { label: 'Iniciativa', value: initiative(x) },
              { label: 'Processo disciplinar', value: x.disciplinaryCase?.code },
              { label: 'Aviso prévio comunicado', value: date(x.noticeGivenOn) },
              { label: 'Último dia de trabalho', value: date(x.lastWorkingDay) },
              {
                label: 'Aviso exigido',
                value:
                  x.noticeRequiredDays === null
                    ? 'Não indicado'
                    : x.noticeRequiredDays + ' dias (' + x.noticeBasis + ')',
              },
              {
                label: 'Indemnização',
                value: x.indemnityApplicable ? 'Aplicável — ' + x.indemnityBasis : 'Não aplicável',
              },
            ]"
          />
        </section>

        <section class="card mt-4" aria-labelledby="tm-settlement-title">
          <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h2 id="tm-settlement-title" class="font-semibold">Liquidação final</h2>
            @if (x.access?.edit) {
              <button
                type="button"
                class="btn-secondary"
                data-testid="tm-add-line"
                (click)="openLine(null)"
              >
                Adicionar linha
              </button>
            }
          </div>
          <p class="mb-3 text-xs text-muted">
            Valores brutos: o IRT e o INSS são calculados no lote, segundo a incidência de cada
            componente. A remuneração do último mês segue no processamento regular desse mês.
          </p>
          <app-data-table
            label="Linhas da liquidação final"
            [columns]="lineColumns"
            [rows]="x.lines ?? []"
            [total]="x.lines?.length ?? 0"
            [limit]="200"
            emptyText="Sem linhas."
          >
            <ng-template appCell="amount" let-row>
              <span [class.text-danger-text]="!earning(row.kind)"
                >{{ earning(row.kind) ? '' : '−' }}{{ money(row.amount) }}</span
              >
            </ng-template>
            <ng-template appCell="actions" let-row>
              @if (x.access?.edit) {
                <span class="flex gap-2">
                  <button type="button" class="link" (click)="openLine(row)">Editar</button>
                  <button type="button" class="link" (click)="removeLine(row)">Remover</button>
                </span>
              }
            </ng-template>
          </app-data-table>
          <dl class="mt-3 grid gap-1 text-sm sm:grid-cols-3" data-testid="tm-totals">
            <div>
              <dt class="text-muted">Abonos</dt>
              <dd class="font-medium">{{ money(x.totals?.earnings ?? '0') }} {{ x.currency }}</dd>
            </div>
            <div>
              <dt class="text-muted">Descontos</dt>
              <dd class="font-medium">{{ money(x.totals?.deductions ?? '0') }} {{ x.currency }}</dd>
            </div>
            <div>
              <dt class="text-muted">Saldo bruto</dt>
              <dd class="font-semibold">{{ money(x.totals?.net ?? '0') }} {{ x.currency }}</dd>
            </div>
          </dl>
          @if (x.settlementRun) {
            <p class="mt-3 text-sm">
              Lote:
              <a
                class="link"
                data-testid="tm-run"
                [routerLink]="['/rh/processamento', x.settlementRun.id]"
                >{{ x.settlementRun.code }}</a
              >
              · {{ runStatus(x.settlementRun.status) }}
            </p>
          }
        </section>

        @if (x.facts; as f) {
          <section class="card mt-4" aria-labelledby="tm-facts">
            <h2 id="tm-facts" class="mb-1 font-semibold">Apoio ao cálculo</h2>
            <p class="mb-3 text-xs text-muted">
              Factos do sistema e sugestões; os critérios e valores legais são confirmados pela
              empresa.
            </p>
            <app-field-list
              [fields]="[
                { label: 'Admissão', value: date(f.hireDate) },
                { label: 'Antiguidade até ao último dia', value: service(x) },
                {
                  label: 'Salário base no último dia',
                  value: f.contract?.baseSalary
                    ? money(f.contract.baseSalary) + ' ' + f.contract.currency
                    : null,
                },
                {
                  label: 'Aviso (dados / exigidos / em falta)',
                  value:
                    (f.notice.given ?? '—') +
                    ' / ' +
                    (f.notice.required ?? '—') +
                    ' / ' +
                    (f.notice.shortfall ?? '—') +
                    ' dias',
                },
                {
                  label: 'Férias ' + f.vacation.year + ' (direito / gozadas / saldo)',
                  value:
                    days(f.vacation.entitled) +
                    ' / ' +
                    days(f.vacation.taken) +
                    ' / ' +
                    days(f.vacation.balance) +
                    (x.status === 'APPROVED' || x.status === 'SETTLED'
                      ? ' (saldo encerrado na aprovação)'
                      : ''),
                },
                {
                  label: 'Proporção do ano trabalhada',
                  value:
                    f.vacation.daysWorkedInYear +
                    ' de ' +
                    f.vacation.daysInYear +
                    ' dias (sugestão sobre o direito acumulado: ' +
                    days(f.vacation.proportionalHint) +
                    ' dias)',
                },
                {
                  label: 'Processamento de ' + month(f.pendingPay.period),
                  value: f.pendingPay.regularRun
                    ? f.pendingPay.regularRun.code +
                      ' · ' +
                      runStatus(f.pendingPay.regularRun.status)
                    : 'Ainda não criado',
                },
                { label: 'Subordinados directos activos', value: '' + f.directReports },
              ]"
            />
            @if (f.pendingPay.runs.length) {
              <p class="mt-3 text-sm font-medium">Remunerações por fechar ou por pagar</p>
              <ul class="text-sm" data-testid="tm-pending-pay">
                @for (r of f.pendingPay.runs; track r.id) {
                  <li>
                    <a class="link" [routerLink]="['/rh/processamento', r.id]">{{ r.code }}</a>
                    · {{ month(r.period) }} ·
                    {{ r.status === 'CLOSED' ? 'fechado, por pagar' : runStatus(r.status) }}
                  </li>
                }
              </ul>
            }
            @if (f.loans.length) {
              <p class="mt-3 text-sm font-medium">Adiantamentos e empréstimos</p>
              <ul class="text-sm" data-testid="tm-loans">
                @for (l of f.loans; track l.id) {
                  <li>
                    <a class="link" [routerLink]="['/rh/emprestimos', l.id]">{{ l.code }}</a>
                    · por liquidar {{ money(l.outstanding) }}
                  </li>
                }
              </ul>
            }
          </section>
        }

        <section class="card mt-4" aria-labelledby="tm-tasks">
          <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h2 id="tm-tasks" class="font-semibold">
              Checklist de saída
              <span class="text-sm font-normal text-muted"
                >({{ progress().done }}/{{ progress().total }})</span
              >
            </h2>
            @if (x.access?.manage) {
              <button
                type="button"
                class="btn-secondary"
                data-testid="tm-add-task"
                (click)="openTask()"
              >
                Adicionar tarefa
              </button>
            }
          </div>
          <ul class="divide-y divide-border text-sm" data-testid="tm-task-list">
            @for (k of x.tasks ?? []; track k.id) {
              <li class="flex flex-wrap items-center justify-between gap-2 py-2">
                <div>
                  <p>
                    <span class="text-muted">{{ category(k) }} ·</span> {{ k.title }}
                  </p>
                  @if (k.notes || k.completedBy) {
                    <p class="text-xs text-muted">
                      {{ k.notes }}{{ k.notes && k.completedBy ? ' · ' : '' }}{{ k.completedBy }}
                    </p>
                  }
                </div>
                <span class="flex items-center gap-2">
                  <span class="badge" [class]="taskTone(k.status)">{{ taskStatus(k.status) }}</span>
                  @if (x.access?.manage) {
                    @if (k.status === 'PENDING') {
                      <button
                        type="button"
                        class="link"
                        [attr.aria-label]="'Marcar feito: ' + k.title"
                        (click)="setTask(k, 'DONE')"
                      >
                        Feito
                      </button>
                      <button
                        type="button"
                        class="link"
                        [attr.aria-label]="'Não se aplica: ' + k.title"
                        (click)="openNa(k)"
                      >
                        Não se aplica
                      </button>
                    } @else {
                      <button
                        type="button"
                        class="link"
                        [attr.aria-label]="'Reabrir: ' + k.title"
                        (click)="setTask(k, 'PENDING')"
                      >
                        Reabrir
                      </button>
                    }
                  }
                </span>
              </li>
            }
          </ul>
          @if (hasAccessTask()) {
            <p class="mt-2 text-xs text-muted">
              O acesso fica tratado quando a conta do colaborador estiver suspensa em
              <a class="link" routerLink="/membros">Membros</a>.
            </p>
          }
        </section>

        <section class="card mt-4" aria-labelledby="tm-docs">
          <h2 id="tm-docs" class="mb-3 font-semibold">Documentos</h2>
          <app-attachments
            subjectType="employee_termination"
            [subjectId]="x.id"
            [canWrite]="!!x.access?.manage"
          />
        </section>

        <div aside>
          <section class="card" aria-labelledby="tm-summary">
            <h2 id="tm-summary" class="mb-3 font-semibold">Resumo</h2>
            <app-field-list
              [fields]="[
                { label: 'Colaborador', value: x.employee.code + ' — ' + x.employee.fullName },
                { label: 'Contrato', value: x.contract.code },
                { label: 'Preparado por', value: x.createdBy },
                { label: 'Submetido por', value: x.submittedBy },
                {
                  label: 'Decidido por',
                  value: x.decidedBy
                    ? x.decidedBy + (x.decisionNote ? ' · ' + x.decisionNote : '')
                    : null,
                },
                { label: 'Concluído em', value: x.settledAt ? date(x.settledAt) : null },
                { label: 'Motivo do cancelamento', value: x.cancelReason },
              ]"
            />
          </section>
        </div>
      </app-page-detail>
    }

    <app-modal title="Editar cessação" [open]="editing()" (closed)="editing.set(false)">
      <app-error-alert [error]="action.error()" [showDetails]="false" />
      <app-termination-fields [form]="form" [action]="action" [cases]="cases()" />
      <ng-container actions>
        <button type="button" class="btn-secondary" (click)="editing.set(false)">Cancelar</button>
        <button
          type="button"
          class="btn-primary"
          data-testid="tm-edit-confirm"
          [disabled]="action.busy()"
          (click)="saveEdit()"
        >
          Guardar
        </button>
      </ng-container>
    </app-modal>

    <app-modal
      [title]="line.id ? 'Editar linha' : 'Adicionar linha'"
      [open]="lineOpen()"
      (closed)="lineOpen.set(false)"
    >
      <app-error-alert [error]="action.error()" [showDetails]="false" />
      <div class="space-y-3">
        <app-field label="Tipo" [required]="true" [error]="action.field('kind')">
          <select
            appControl
            class="input"
            data-testid="tl-kind"
            [(ngModel)]="line.kind"
            [ngModelOptions]="{ standalone: true }"
            (ngModelChange)="line.componentId = ''"
          >
            @for (k of kinds(); track k[0]) {
              <option [value]="k[0]">{{ k[1] }}</option>
            }
          </select>
        </app-field>
        <app-field
          label="Componente salarial"
          [required]="true"
          hint="Define a incidência de IRT e INSS no lote."
          [error]="action.field('componentId')"
        >
          <select
            appControl
            class="input"
            data-testid="tl-component"
            [(ngModel)]="line.componentId"
            [ngModelOptions]="{ standalone: true }"
          >
            <option value="">—</option>
            @for (c of componentsFor(line.kind); track c.id) {
              <option [value]="c.id">{{ c.code }} — {{ c.name }}</option>
            }
          </select>
        </app-field>
        <app-field label="Descrição" [required]="true" [error]="action.field('description')">
          <input
            appControl
            class="input"
            data-testid="tl-description"
            [(ngModel)]="line.description"
            [ngModelOptions]="{ standalone: true }"
          />
        </app-field>
        <div class="grid gap-3 sm:grid-cols-2">
          <app-field
            label="Quantidade (dias, meses…)"
            hint="Opcional, com o valor unitário."
            [error]="action.field('quantity')"
          >
            <input
              appControl
              class="input"
              inputmode="decimal"
              data-testid="tl-quantity"
              [(ngModel)]="line.quantity"
              [ngModelOptions]="{ standalone: true }"
              (ngModelChange)="recalc()"
            />
          </app-field>
          <app-field label="Valor unitário" [error]="action.field('rate')">
            <input
              appControl
              class="input"
              inputmode="decimal"
              data-testid="tl-rate"
              [(ngModel)]="line.rate"
              [ngModelOptions]="{ standalone: true }"
              (ngModelChange)="recalc()"
            />
          </app-field>
        </div>
        <app-field label="Montante" [required]="true" [error]="action.field('amount')">
          <app-money-input
            data-testid="tl-amount"
            [currency]="t()?.currency ?? ''"
            [(ngModel)]="line.amount"
            [ngModelOptions]="{ standalone: true }"
          />
        </app-field>
        <app-field
          label="Fundamentação"
          [required]="true"
          hint="Como foi calculado e com que base (contrato, lei, convenção)."
          [error]="action.field('basis')"
        >
          <textarea
            appControl
            class="input min-h-16"
            data-testid="tl-basis"
            [(ngModel)]="line.basis"
            [ngModelOptions]="{ standalone: true }"
          ></textarea>
        </app-field>
      </div>
      <ng-container actions>
        <button type="button" class="btn-secondary" (click)="lineOpen.set(false)">Cancelar</button>
        <button
          type="button"
          class="btn-primary"
          data-testid="tl-confirm"
          [disabled]="action.busy()"
          (click)="saveLine()"
        >
          Guardar
        </button>
      </ng-container>
    </app-modal>

    <app-modal
      [title]="approving() ? 'Aprovar cessação' : 'Devolver cessação'"
      [open]="deciding()"
      (closed)="deciding.set(false)"
    >
      <app-error-alert [error]="action.error()" [showDetails]="false" />
      @if (approving()) {
        <p class="mb-3 text-sm">
          Ao aprovar, o contrato termina no último dia, o colaborador passa a «cessou funções» e o
          saldo de férias do ano fecha. Não se desfaz.
        </p>
      }
      <app-field
        [label]="approving() ? 'Nota (opcional)' : 'Motivo da devolução'"
        [required]="!approving()"
        [error]="action.field('note')"
      >
        <textarea
          appControl
          class="input min-h-16"
          data-testid="tm-note"
          [(ngModel)]="note"
          [ngModelOptions]="{ standalone: true }"
        ></textarea>
      </app-field>
      <ng-container actions>
        <button type="button" class="btn-secondary" (click)="deciding.set(false)">Voltar</button>
        <button
          type="button"
          class="btn-primary"
          data-testid="tm-decide-confirm"
          [disabled]="action.busy()"
          (click)="decide()"
        >
          {{ approving() ? 'Aprovar' : 'Devolver' }}
        </button>
      </ng-container>
    </app-modal>

    <app-modal title="Cancelar processo" [open]="cancelling()" (closed)="cancelling.set(false)">
      <app-error-alert [error]="action.error()" [showDetails]="false" />
      <app-field label="Motivo" [required]="true" [error]="action.field('reason')">
        <textarea
          appControl
          class="input min-h-16"
          data-testid="tm-cancel-reason"
          [(ngModel)]="note"
          [ngModelOptions]="{ standalone: true }"
        ></textarea>
      </app-field>
      <ng-container actions>
        <button type="button" class="btn-secondary" (click)="cancelling.set(false)">Voltar</button>
        <button
          type="button"
          class="btn-primary"
          data-testid="tm-cancel-confirm"
          [disabled]="action.busy()"
          (click)="cancel()"
        >
          Cancelar processo
        </button>
      </ng-container>
    </app-modal>

    <app-modal title="Adicionar tarefa" [open]="taskOpen()" (closed)="taskOpen.set(false)">
      <app-error-alert [error]="action.error()" [showDetails]="false" />
      <div class="space-y-3">
        <app-field label="Categoria" [required]="true" [error]="action.field('category')">
          <select
            appControl
            class="input"
            data-testid="tt-category"
            [(ngModel)]="task.category"
            [ngModelOptions]="{ standalone: true }"
          >
            @for (c of categories; track c[0]) {
              <option [value]="c[0]">{{ c[1] }}</option>
            }
          </select>
        </app-field>
        <app-field label="Tarefa" [required]="true" [error]="action.field('title')">
          <input
            appControl
            class="input"
            data-testid="tt-title"
            [(ngModel)]="task.title"
            [ngModelOptions]="{ standalone: true }"
          />
        </app-field>
      </div>
      <ng-container actions>
        <button type="button" class="btn-secondary" (click)="taskOpen.set(false)">Cancelar</button>
        <button
          type="button"
          class="btn-primary"
          data-testid="tt-confirm"
          [disabled]="action.busy()"
          (click)="saveTask()"
        >
          Adicionar
        </button>
      </ng-container>
    </app-modal>

    <app-modal title="Não se aplica" [open]="naOpen()" (closed)="naOpen.set(false)">
      <app-error-alert [error]="action.error()" [showDetails]="false" />
      <app-field label="Justificação" [error]="action.field('notes')">
        <textarea
          appControl
          class="input min-h-16"
          data-testid="tt-na-notes"
          [(ngModel)]="note"
          [ngModelOptions]="{ standalone: true }"
        ></textarea>
      </app-field>
      <ng-container actions>
        <button type="button" class="btn-secondary" (click)="naOpen.set(false)">Voltar</button>
        <button
          type="button"
          class="btn-primary"
          data-testid="tt-na-confirm"
          [disabled]="action.busy()"
          (click)="confirmNa()"
        >
          Confirmar
        </button>
      </ng-container>
    </app-modal>
  `,
})
export class TerminationPage {
  readonly id = input.required<string>();
  private readonly api = inject(Api);
  private readonly toasts = inject(ToastService);
  private readonly confirm = inject(ConfirmService);
  private readonly breadcrumbs = inject(Breadcrumbs);
  private readonly workspace = inject(Workspace);
  protected readonly t = signal<Termination | null>(null);
  protected readonly loadError = signal<ApiError | null>(null);
  protected readonly components = signal<PayComponent[]>([]);
  protected readonly cases = signal<{ id: string; label: string }[]>([]);
  protected readonly editing = signal(false);
  protected readonly lineOpen = signal(false);
  protected readonly deciding = signal(false);
  protected readonly approving = signal(true);
  protected readonly cancelling = signal(false);
  protected readonly taskOpen = signal(false);
  protected readonly naOpen = signal(false);
  protected readonly action = new Action();
  protected form: TerminationForm = emptyTerminationForm();
  protected line: LineForm = this.emptyLine();
  protected task: { category: TerminationTask['category']; title: string } = {
    category: 'EQUIPMENT',
    title: '',
  };
  protected note = '';
  private naTask: TerminationTask | null = null;
  protected readonly categories = Object.entries(TASK_CATEGORY);
  protected readonly date = (d: string | null) => (d ? formatDate(d) : null);
  protected readonly money = (v: string) => formatMoney(v);
  protected readonly days = (v: string) => v.replace('.', ',');
  protected readonly month = monthName;
  protected readonly tone = terminationTone;
  protected readonly taskTone = taskTone;
  protected readonly earning = isEarning;
  protected readonly status = (x: Termination) => TERMINATION_STATUS[x.status];
  protected readonly reason = (x: Termination) => TERMINATION_REASON[x.reason];
  protected readonly initiative = (x: Termination) => INITIATIVE[x.initiative];
  protected readonly service = (x: Termination) => (x.facts ? serviceLabel(x.facts.service) : null);
  protected readonly category = (k: TerminationTask) => TASK_CATEGORY[k.category];
  protected readonly taskStatus = (s: TaskStatus) => TASK_STATUS[s];
  protected readonly runStatus = (s: string) => RUN_STATUS[s as RunStatus] ?? s;
  protected readonly next = computed(() => (this.t() ? nextStep(this.t()!) : ''));
  protected readonly progress = computed(() => checklistProgress(this.t()?.tasks ?? []));
  protected readonly hasAccessTask = computed(() =>
    (this.t()?.tasks ?? []).some((k) => k.kind === 'SYSTEM_ACCESS' && k.status === 'PENDING'),
  );
  protected readonly canGenerate = computed(() => {
    const x = this.t();
    return !!x?.lines?.length && (!x.settlementRun || x.settlementRun.status === 'CANCELLED');
  });
  protected readonly kinds = computed(() =>
    Object.entries(SETTLEMENT_KIND).filter(
      ([k]) => k !== 'INDEMNITY' || this.t()?.indemnityApplicable,
    ),
  );
  protected readonly lineColumns: Column<SettlementLine>[] = [
    { key: 'kind', label: 'Tipo', value: (l) => SETTLEMENT_KIND[l.kind] },
    { key: 'description', label: 'Descrição' },
    {
      key: 'component',
      label: 'Componente',
      hideOnMobile: true,
      value: (l) => l.component.code,
    },
    {
      key: 'quantity',
      label: 'Qtd. × valor',
      hideOnMobile: true,
      value: (l) => (l.quantity ? `${l.quantity} × ${formatMoney(l.rate, 4)}` : '—'),
    },
    { key: 'amount', label: 'Montante', align: 'end' },
    { key: 'basis', label: 'Fundamentação', hideOnMobile: true },
    { key: 'actions', label: 'Acções', required: true },
  ];

  constructor() {
    effect(() => {
      const id = this.id();
      untracked(() => void this.load(id));
    });
  }

  protected reload() {
    void this.load(this.id());
  }

  private async load(id: string) {
    this.loadError.set(null);
    try {
      const x = await this.api.get<Termination>(`hr/terminations/${id}`);
      this.t.set(x);
      this.breadcrumbs.setCurrent(`Cessação ${x.code}`);
    } catch (error) {
      this.loadError.set(ApiError.from(error));
    }
  }

  private emptyLine(): LineForm {
    return {
      id: null,
      kind: 'UNUSED_VACATION',
      componentId: '',
      description: '',
      quantity: '',
      rate: '',
      amount: null,
      basis: '',
    };
  }

  protected componentsFor(kind: SettlementKind) {
    const want = isEarning(kind) ? 'EARNING' : 'DEDUCTION';
    return this.components().filter((c) => c.kind === want && c.status === 'ACTIVE');
  }

  private async loadComponents() {
    if (this.components().length) return;
    try {
      this.components.set(await this.api.get<PayComponent[]>('hr/pay-components'));
    } catch {
      this.components.set([]);
    }
  }

  private done(x: Termination | undefined, message: string) {
    if (!x) return false;
    this.t.set(x);
    this.toasts.show(message);
    return true;
  }

  /** Erro numa acção sem formulário: os motivos (detalhes) dizem o que falta. */
  private fail() {
    const e = this.action.error();
    const why = e?.details?.map((d) => d.message).join(' ');
    this.toasts.show(why || e?.message || 'Não foi possível concluir.', 'error');
  }

  protected async openEdit() {
    const x = this.t()!;
    this.action.error.set(null);
    this.form = {
      reason: x.reason,
      details: x.details,
      disciplinaryCaseId: x.disciplinaryCase?.id ?? '',
      noticeGivenOn: x.noticeGivenOn ?? '',
      lastWorkingDay: x.lastWorkingDay,
      noticeRequiredDays: x.noticeRequiredDays === null ? '' : String(x.noticeRequiredDays),
      noticeBasis: x.noticeBasis ?? '',
      indemnityApplicable: x.indemnityApplicable,
      indemnityBasis: x.indemnityBasis ?? '',
    };
    this.editing.set(true);
    if (
      this.workspace.canAny('hr.discipline.read') ||
      this.workspace.canAny('hr.discipline.manage')
    )
      try {
        const page = await this.api.page<{ id: string; code: string; summary: string }>(
          'hr/discipline/cases',
          { employeeId: x.employee.id, limit: 50 },
        );
        this.cases.set(page.items.map((c) => ({ id: c.id, label: `${c.code} · ${c.summary}` })));
      } catch {
        this.cases.set([]);
      }
  }

  protected async saveEdit() {
    const x = this.t()!;
    const r = await this.action.run(() =>
      this.api.patch<Termination>(`hr/terminations/${x.id}`, {
        ...terminationPayload(this.form),
        expectedVersion: x.version,
      }),
    );
    if (this.done(r, 'Cessação actualizada.')) this.editing.set(false);
  }

  protected async openLine(l: SettlementLine | null) {
    this.action.error.set(null);
    await this.loadComponents();
    this.line = l
      ? {
          id: l.id,
          kind: l.kind,
          componentId: l.component.id,
          description: l.description,
          quantity: l.quantity ?? '',
          rate: l.rate ?? '',
          amount: l.amount,
          basis: l.basis,
        }
      : this.emptyLine();
    this.lineOpen.set(true);
  }

  /** Quantidade × valor unitário preenche o montante (o servidor volta a verificar). */
  protected recalc() {
    const a = lineAmount(this.line.quantity, this.line.rate);
    if (a !== null) this.line.amount = a;
  }

  protected async saveLine() {
    const x = this.t()!;
    const body = {
      kind: this.line.kind,
      componentId: this.line.componentId || null,
      description: this.line.description,
      quantity: this.line.quantity.trim().replace(',', '.') || null,
      rate: this.line.rate.trim().replace(',', '.') || null,
      amount: this.line.amount,
      basis: this.line.basis,
      expectedVersion: x.version,
    };
    const r = await this.action.run(() =>
      this.line.id
        ? this.api.patch<Termination>(`hr/terminations/${x.id}/lines/${this.line.id}`, body)
        : this.api.post<Termination>(`hr/terminations/${x.id}/lines`, body),
    );
    if (this.done(r, 'Linha guardada.')) this.lineOpen.set(false);
  }

  protected async removeLine(l: SettlementLine) {
    const ok = await this.confirm.ask({
      title: 'Remover linha',
      message: `Remover «${l.description}» da liquidação?`,
      confirmLabel: 'Remover',
      danger: true,
    });
    if (!ok) return;
    const x = this.t()!;
    const r = await this.action.run(async () => {
      await this.api.delete(`hr/terminations/${x.id}/lines/${l.id}`);
      return true;
    });
    if (!r) return this.fail();
    this.toasts.show('Linha removida.');
    this.reload();
  }

  protected async submit() {
    const x = this.t()!;
    const r = await this.action.run(() =>
      this.api.post<Termination>(`hr/terminations/${x.id}/submit`, { expectedVersion: x.version }),
    );
    if (!this.done(r, 'Submetida para aprovação.')) {
      this.fail();
      this.reload();
    }
  }

  protected openDecision(approve: boolean) {
    this.action.error.set(null);
    this.approving.set(approve);
    this.note = '';
    this.deciding.set(true);
  }

  protected async decide() {
    const x = this.t()!;
    const r = await this.action.run(() =>
      this.api.post<Termination>(`hr/terminations/${x.id}/decision`, {
        approve: this.approving(),
        note: this.note || null,
        expectedVersion: x.version,
      }),
    );
    if (this.done(r, this.approving() ? 'Cessação aprovada.' : 'Cessação devolvida.'))
      this.deciding.set(false);
  }

  protected openCancel() {
    this.action.error.set(null);
    this.note = '';
    this.cancelling.set(true);
  }

  protected async cancel() {
    const x = this.t()!;
    const r = await this.action.run(() =>
      this.api.post<{ id: string }>(`hr/terminations/${x.id}/cancel`, {
        reason: this.note || null,
        expectedVersion: x.version,
      }),
    );
    if (!r) return;
    this.cancelling.set(false);
    this.toasts.show('Processo cancelado.');
    this.reload();
  }

  protected async settlement() {
    const x = this.t()!;
    const ok = await this.confirm.ask({
      title: 'Gerar lote da liquidação',
      message:
        'Cria um lote extra no processamento salarial com os valores aprovados. Os valores não se alteram no lote.',
      confirmLabel: 'Gerar',
    });
    if (!ok) return;
    const r = await this.action.run(() =>
      this.api.post<Termination>(`hr/terminations/${x.id}/settlement`, {
        expectedVersion: x.version,
      }),
    );
    if (!this.done(r, 'Lote da liquidação criado.')) this.fail();
  }

  protected async complete() {
    const x = this.t()!;
    const ok = await this.confirm.ask({
      title: 'Concluir cessação',
      message: 'Concluído, o processo e a checklist deixam de mudar. Confirma?',
      confirmLabel: 'Concluir',
    });
    if (!ok) return;
    const r = await this.action.run(() =>
      this.api.post<Termination>(`hr/terminations/${x.id}/complete`, {
        expectedVersion: x.version,
      }),
    );
    if (!this.done(r, 'Cessação concluída.')) this.fail();
  }

  protected openTask() {
    this.action.error.set(null);
    this.task = { category: 'EQUIPMENT', title: '' };
    this.taskOpen.set(true);
  }

  protected async saveTask() {
    const x = this.t()!;
    const r = await this.action.run(() =>
      this.api.post<Termination>(`hr/terminations/${x.id}/tasks`, {
        ...this.task,
        expectedVersion: x.version,
      }),
    );
    if (this.done(r, 'Tarefa adicionada.')) this.taskOpen.set(false);
  }

  protected async setTask(k: TerminationTask, status: TaskStatus, notes: string | null = null) {
    const r = await this.action.run(() =>
      this.api.patch<Termination>(`hr/termination-tasks/${k.id}`, {
        status,
        notes,
        expectedVersion: k.version,
      }),
    );
    if (!this.done(r, 'Checklist actualizada.')) this.fail();
    return !!r;
  }

  protected openNa(k: TerminationTask) {
    this.action.error.set(null);
    this.naTask = k;
    this.note = '';
    this.naOpen.set(true);
  }

  protected async confirmNa() {
    if (!this.naTask) return;
    const r = await this.action.run(() =>
      this.api.patch<Termination>(`hr/termination-tasks/${this.naTask!.id}`, {
        status: 'NOT_APPLICABLE',
        notes: this.note || null,
        expectedVersion: this.naTask!.version,
      }),
    );
    if (this.done(r, 'Checklist actualizada.')) this.naOpen.set(false);
  }
}
