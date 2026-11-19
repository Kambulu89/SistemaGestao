import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { Api, ApiError } from '../core/api';
import { Breadcrumbs } from '../core/breadcrumbs';
import { Workspace } from '../core/workspace';
import { AuditHistory } from '../ui/audit-history';
import { ConfirmService } from '../ui/confirm';
import { formatDate, formatDateTime } from '../ui/dates';
import { FieldList } from '../ui/detail-drawer';
import { ErrorAlert } from '../ui/error-alert';
import { FieldControl, FormField } from '../ui/form-field';
import { Icon } from '../ui/icon';
import { Action } from '../ui/load';
import { Modal } from '../ui/modal';
import { formatMoney, MoneyInput } from '../ui/money-input';
import { PageDetail } from '../ui/page-detail';
import { ErrorState, Skeleton } from '../ui/states';
import { ToastService } from '../ui/toasts';
import {
  type Application,
  activeOffer,
  canOffer,
  INTERVIEW_MODE,
  INTERVIEW_STATUS,
  type Interview,
  OFFER_STATUS,
  type Offer,
  offerActions,
  ONBOARDING_CATEGORY,
  type OnboardingCategory,
  RECOMMENDATION,
  STAGE,
  STAGE_ACTION_LABEL,
  STAGE_ACTIONS,
  type Stage,
  suggestedChecklist,
  tone,
  withinRange,
} from './recruitment-model';

interface Member {
  id: string;
  label: string;
}

/**
 * Candidatura: etapas, entrevistas, avaliações, proposta (dentro da remuneração autorizada, aprovada por outra pessoa
 * ou pelo workflow) e contratação, que cria o colaborador e a checklist de onboarding numa só operação no servidor.
 */
@Component({
  selector: 'app-application-detail',
  imports: [
    FormsModule,
    RouterLink,
    PageDetail,
    FormField,
    FieldControl,
    FieldList,
    AuditHistory,
    Modal,
    MoneyInput,
    ErrorAlert,
    ErrorState,
    Skeleton,
    Icon,
  ],
  template: `
    @if (loadError()) {
      <app-error-state [error]="loadError()" (retry)="reload()" />
    } @else if (!app()) {
      <div class="card"><app-skeleton /></div>
    } @else {
      @let a = app()!;
      <app-page-detail
        [title]="a.candidate.fullName"
        [subtitle]="a.requisition.code + ' — ' + a.requisition.title"
      >
        <ng-container actions>
          <a class="btn-secondary" [routerLink]="['/rh/vagas', a.requisition.id]">Voltar à vaga</a>
          @if (a.access?.manage) {
            @for (s of stageActions(); track s) {
              <button
                type="button"
                class="btn-secondary"
                [attr.data-testid]="'stage-' + s"
                (click)="changeStage(s)"
              >
                {{ stageActionLabel(s) }}
              </button>
            }
          }
        </ng-container>

        <div class="space-y-4">
          <section class="card" aria-labelledby="app-interviews">
            <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h2 id="app-interviews" class="font-semibold">Entrevistas</h2>
              @if (a.access?.manage && ['APPLIED', 'SCREENING', 'INTERVIEW'].includes(a.stage)) {
                <button
                  type="button"
                  class="btn-secondary"
                  data-testid="schedule"
                  (click)="openInterview()"
                >
                  <app-icon name="calendar" [size]="16" />Marcar entrevista
                </button>
              }
            </div>
            @if (a.interviews?.length) {
              <ul class="divide-y divide-border text-sm">
                @for (i of a.interviews; track i.id) {
                  <li
                    class="flex flex-wrap items-center justify-between gap-2 py-2"
                    data-testid="interview"
                  >
                    <div class="min-w-0">
                      <p class="font-medium">
                        {{ dateTime(i.scheduledAt) }} · {{ mode(i.mode) }} ·
                        {{ i.durationMinutes }} min
                      </p>
                      <p class="text-muted">
                        {{ i.interviewer.name }}{{ i.location ? ' · ' + i.location : '' }}
                      </p>
                    </div>
                    <div class="flex flex-wrap items-center gap-2">
                      <span class="badge" [class]="tone(i.status)">{{
                        interviewStatus(i.status)
                      }}</span>
                      @if (a.access?.manage && i.status === 'SCHEDULED') {
                        <button type="button" class="btn-ghost" (click)="setInterview(i, 'DONE')">
                          Realizada
                        </button>
                        <button
                          type="button"
                          class="btn-ghost"
                          (click)="setInterview(i, 'CANCELLED')"
                        >
                          Cancelar
                        </button>
                      }
                    </div>
                  </li>
                }
              </ul>
            } @else {
              <p class="text-sm text-muted">Sem entrevistas marcadas.</p>
            }
          </section>

          <section class="card" aria-labelledby="app-evals">
            <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h2 id="app-evals" class="font-semibold">Avaliações</h2>
              @if (a.access?.manage && !closed()) {
                <button
                  type="button"
                  class="btn-secondary"
                  data-testid="evaluate"
                  (click)="openEvaluation()"
                >
                  Avaliar
                </button>
              }
            </div>
            @if (a.evaluations?.length) {
              <ul class="divide-y divide-border text-sm">
                @for (e of a.evaluations; track e.id) {
                  <li class="py-2">
                    <p class="font-medium">
                      {{ e.evaluator.name }} · {{ e.score }}/5 ·
                      {{ recommendation(e.recommendation) }}
                    </p>
                    @if (e.comments) {
                      <p class="text-muted">{{ e.comments }}</p>
                    }
                  </li>
                }
              </ul>
            } @else {
              <p class="text-sm text-muted">Sem avaliações.</p>
            }
          </section>

          <section class="card" aria-labelledby="app-offer">
            <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h2 id="app-offer" class="font-semibold">Proposta</h2>
              @if (a.access?.manage && canOffer(a)) {
                <button
                  type="button"
                  class="btn-primary"
                  data-testid="new-offer"
                  (click)="openOffer(null)"
                >
                  Preparar proposta
                </button>
              }
            </div>
            @for (o of a.offers ?? []; track o.id) {
              <div class="mb-3 rounded-card border border-border p-3 last:mb-0" data-testid="offer">
                <div class="flex flex-wrap items-center justify-between gap-2">
                  <p class="font-medium tabular-nums">
                    {{ money(o.salary) }} {{ o.currency }} · início {{ date(o.startDate) }}
                  </p>
                  <span class="badge" [class]="tone(o.status)" data-testid="offer-status">{{
                    offerStatus(o.status)
                  }}</span>
                </div>
                @if (o.expiresOn) {
                  <p class="text-sm text-muted">Válida até {{ date(o.expiresOn) }}</p>
                }
                @if (o.conditions) {
                  <p class="mt-1 text-sm">{{ o.conditions }}</p>
                }
                @if (o.rejectionReason && o.status === 'DRAFT') {
                  <p class="mt-2 rounded-card bg-warning-soft p-2 text-sm text-warning-text">
                    Recusada: {{ o.rejectionReason }}
                  </p>
                }
                @if (o.status === 'PENDING_APPROVAL' && o.approvalRequestId) {
                  <a
                    class="link mt-2 inline-block text-sm"
                    [routerLink]="['/aprovacoes/pedidos', o.approvalRequestId]"
                    >Ver pedido de aprovação</a
                  >
                }
                @if (
                  o.status === 'PENDING_APPROVAL' &&
                  a.offerApprovalMode === 'DIRECT' &&
                  !o.canApprove
                ) {
                  <p class="mt-2 text-sm text-muted">
                    Aguarda a aprovação de outra pessoa com permissão no âmbito da vaga.
                  </p>
                }
                @if (o.employeeId) {
                  <a
                    class="link mt-2 inline-block text-sm"
                    data-testid="employee-link"
                    [routerLink]="['/rh/colaboradores', o.employeeId]"
                    >Ver ficha do colaborador</a
                  >
                }
                <div class="mt-3 flex flex-wrap gap-2">
                  @for (act of actionsFor(o); track act) {
                    <button
                      type="button"
                      [class]="
                        act === 'hire' || act === 'approve' || act === 'submit' || act === 'accept'
                          ? 'btn-primary'
                          : 'btn-secondary'
                      "
                      [attr.data-testid]="'offer-' + act"
                      (click)="offerAction(o, act)"
                    >
                      {{ offerActionLabel[act] }}
                    </button>
                  }
                </div>
              </div>
            } @empty {
              <p class="text-sm text-muted">Sem propostas.</p>
            }
          </section>
        </div>

        <div aside>
          <section class="card" aria-labelledby="app-summary">
            <h2 id="app-summary" class="mb-3 font-semibold">Resumo</h2>
            <p class="mb-3">
              <span class="badge" [class]="tone(a.stage)" data-testid="stage">{{
                stage(a.stage)
              }}</span>
            </p>
            @if (a.stageReason) {
              <p class="mb-3 text-sm text-muted">Motivo: {{ a.stageReason }}</p>
            }
            <app-field-list
              [fields]="[
                { label: 'Email', value: a.candidate.email },
                { label: 'Telefone', value: a.candidate.phone },
                {
                  label: 'Remuneração autorizada',
                  value:
                    money(a.requisition.salaryMin) +
                    ' – ' +
                    money(a.requisition.salaryMax) +
                    ' ' +
                    a.requisition.currency,
                },
                { label: 'Avaliação média', value: a.averageScore ?? '—' },
                { label: 'Recebida', value: date(a.createdAt) },
              ]"
            />
            <a
              class="link mt-3 inline-block text-sm"
              [routerLink]="['/rh/candidatos', a.candidate.id]"
              >Ficha do candidato</a
            >
          </section>
          <app-audit-history
            entityType="job_application"
            [entityId]="a.id"
            [refreshKey]="a.version"
          />
        </div>
      </app-page-detail>
    }

    <!-- Motivo (recusar candidatura/proposta, cancelar proposta) -->
    <app-modal [title]="reasonTitle()" [open]="reasonFor() !== null" (closed)="reasonFor.set(null)">
      <app-error-alert [error]="action.error()" />
      <app-field label="Motivo" [required]="reasonRequired()">
        <textarea
          appControl
          class="input min-h-24"
          data-testid="reason"
          [(ngModel)]="reason"
          [ngModelOptions]="{ standalone: true }"
        ></textarea>
      </app-field>
      <ng-container actions>
        <button type="button" class="btn-secondary" (click)="reasonFor.set(null)">Voltar</button>
        <button
          type="button"
          class="btn-primary"
          data-testid="reason-confirm"
          [disabled]="action.busy()"
          (click)="confirmReason()"
        >
          Confirmar
        </button>
      </ng-container>
    </app-modal>

    <!-- Entrevista -->
    <app-modal
      title="Marcar entrevista"
      [open]="interviewOpen()"
      (closed)="interviewOpen.set(false)"
    >
      <app-error-alert [error]="dialog.error()" [showDetails]="false" />
      <div class="space-y-3">
        <app-field label="Data e hora" [required]="true" [error]="dialog.field('scheduledAt')">
          <input
            appControl
            class="input"
            type="datetime-local"
            data-testid="iv-at"
            [(ngModel)]="iv.at"
            [ngModelOptions]="{ standalone: true }"
          />
        </app-field>
        <app-field label="Duração (minutos)" [error]="dialog.field('durationMinutes')">
          <input
            appControl
            class="input"
            type="number"
            min="5"
            max="480"
            [(ngModel)]="iv.duration"
            [ngModelOptions]="{ standalone: true }"
          />
        </app-field>
        <app-field label="Modo" [required]="true" [error]="dialog.field('mode')">
          <select
            appControl
            class="input"
            data-testid="iv-mode"
            [(ngModel)]="iv.mode"
            [ngModelOptions]="{ standalone: true }"
          >
            @for (m of modes; track m[0]) {
              <option [ngValue]="m[0]">{{ m[1] }}</option>
            }
          </select>
        </app-field>
        <app-field label="Local ou ligação" [error]="dialog.field('location')">
          <input
            appControl
            class="input"
            [(ngModel)]="iv.location"
            [ngModelOptions]="{ standalone: true }"
          />
        </app-field>
        <app-field
          label="Entrevistador"
          [required]="true"
          [error]="dialog.field('interviewerMembershipId')"
          [hint]="members().length ? null : 'Precisa de permissão para ver os membros da empresa.'"
        >
          <select
            appControl
            class="input"
            data-testid="iv-interviewer"
            [(ngModel)]="iv.interviewer"
            [ngModelOptions]="{ standalone: true }"
          >
            <option [ngValue]="null">—</option>
            @for (m of members(); track m.id) {
              <option [ngValue]="m.id">{{ m.label }}</option>
            }
          </select>
        </app-field>
      </div>
      <ng-container actions>
        <button type="button" class="btn-secondary" (click)="interviewOpen.set(false)">
          Cancelar
        </button>
        <button
          type="button"
          class="btn-primary"
          data-testid="iv-confirm"
          [disabled]="dialog.busy()"
          (click)="saveInterview()"
        >
          Marcar
        </button>
      </ng-container>
    </app-modal>

    <!-- Avaliação -->
    <app-modal
      title="Avaliar candidatura"
      [open]="evaluationOpen()"
      (closed)="evaluationOpen.set(false)"
    >
      <app-error-alert [error]="dialog.error()" [showDetails]="false" />
      <div class="space-y-3">
        <app-field
          label="Entrevista"
          hint="Opcional: só entrevistas realizadas."
          [error]="dialog.field('interviewId')"
        >
          <select
            appControl
            class="input"
            [(ngModel)]="ev.interviewId"
            [ngModelOptions]="{ standalone: true }"
          >
            <option [ngValue]="null">Avaliação geral</option>
            @for (i of doneInterviews(); track i.id) {
              <option [ngValue]="i.id">
                {{ dateTime(i.scheduledAt) }} · {{ i.interviewer.name }}
              </option>
            }
          </select>
        </app-field>
        <app-field label="Classificação (1 a 5)" [required]="true" [error]="dialog.field('score')">
          <select
            appControl
            class="input"
            data-testid="ev-score"
            [(ngModel)]="ev.score"
            [ngModelOptions]="{ standalone: true }"
          >
            @for (n of [1, 2, 3, 4, 5]; track n) {
              <option [ngValue]="n">{{ n }}</option>
            }
          </select>
        </app-field>
        <app-field label="Recomendação" [required]="true" [error]="dialog.field('recommendation')">
          <select
            appControl
            class="input"
            data-testid="ev-rec"
            [(ngModel)]="ev.recommendation"
            [ngModelOptions]="{ standalone: true }"
          >
            @for (r of recommendations; track r[0]) {
              <option [ngValue]="r[0]">{{ r[1] }}</option>
            }
          </select>
        </app-field>
        <app-field label="Comentários" [error]="dialog.field('comments')">
          <textarea
            appControl
            class="input min-h-24"
            [(ngModel)]="ev.comments"
            [ngModelOptions]="{ standalone: true }"
          ></textarea>
        </app-field>
      </div>
      <ng-container actions>
        <button type="button" class="btn-secondary" (click)="evaluationOpen.set(false)">
          Cancelar
        </button>
        <button
          type="button"
          class="btn-primary"
          data-testid="ev-confirm"
          [disabled]="dialog.busy()"
          (click)="saveEvaluation()"
        >
          Registar avaliação
        </button>
      </ng-container>
    </app-modal>

    <!-- Proposta -->
    <app-modal
      [title]="offerEditing() ? 'Alterar proposta' : 'Preparar proposta'"
      [open]="offerOpen()"
      (closed)="offerOpen.set(false)"
    >
      <app-error-alert [error]="dialog.error()" [showDetails]="false" />
      @if (app(); as a) {
        <p class="mb-3 text-sm text-muted">
          Remuneração autorizada: {{ money(a.requisition.salaryMin) }} –
          {{ money(a.requisition.salaryMax) }} {{ a.requisition.currency }}.
        </p>
        <div class="space-y-3">
          <app-field
            label="Salário"
            [required]="true"
            [error]="
              dialog.field('salary') ??
              (of.salary && !inRange() ? 'Fora da remuneração autorizada da vaga.' : null)
            "
          >
            <app-money-input
              data-testid="of-salary"
              [currency]="a.requisition.currency"
              [(ngModel)]="of.salary"
              [ngModelOptions]="{ standalone: true }"
            />
          </app-field>
          <app-field label="Data de início" [required]="true" [error]="dialog.field('startDate')">
            <input
              appControl
              class="input"
              type="date"
              data-testid="of-start"
              [(ngModel)]="of.startDate"
              [ngModelOptions]="{ standalone: true }"
            />
          </app-field>
          <app-field label="Válida até" [error]="dialog.field('expiresOn')">
            <input
              appControl
              class="input"
              type="date"
              [(ngModel)]="of.expiresOn"
              [ngModelOptions]="{ standalone: true }"
            />
          </app-field>
          <app-field label="Condições" [error]="dialog.field('conditions')">
            <textarea
              appControl
              class="input min-h-24"
              [(ngModel)]="of.conditions"
              [ngModelOptions]="{ standalone: true }"
            ></textarea>
          </app-field>
        </div>
      }
      <ng-container actions>
        <button type="button" class="btn-secondary" (click)="offerOpen.set(false)">Cancelar</button>
        <button
          type="button"
          class="btn-primary"
          data-testid="of-confirm"
          [disabled]="dialog.busy()"
          (click)="saveOffer()"
        >
          Guardar proposta
        </button>
      </ng-container>
    </app-modal>

    <!-- Contratação -->
    <app-modal
      title="Contratar e iniciar onboarding"
      [open]="hireOpen()"
      (closed)="hireOpen.set(false)"
    >
      <app-error-alert [error]="dialog.error()" [showDetails]="false" />
      <p class="mb-3 text-sm text-muted">
        Cria a ficha do colaborador com a colocação da vaga e o nome do candidato. Os contactos do
        candidato passam a dados pessoais só se tiver acesso a dados pessoais.
      </p>
      <div class="space-y-3">
        <app-field label="Código do colaborador" [required]="true" [error]="dialog.field('code')">
          <input
            appControl
            class="input"
            data-testid="hire-code"
            [(ngModel)]="hire.code"
            [ngModelOptions]="{ standalone: true }"
          />
        </app-field>
        <app-field
          label="Data de admissão"
          hint="Por omissão, a data de início da proposta."
          [error]="dialog.field('hireDate')"
        >
          <input
            appControl
            class="input"
            type="date"
            [(ngModel)]="hire.hireDate"
            [ngModelOptions]="{ standalone: true }"
          />
        </app-field>
        <app-field label="Email profissional" [error]="dialog.field('workEmail')">
          <input
            appControl
            class="input"
            type="email"
            [(ngModel)]="hire.workEmail"
            [ngModelOptions]="{ standalone: true }"
          />
        </app-field>
        <fieldset class="min-w-0">
          <legend class="mb-2 text-sm font-medium">Checklist de onboarding</legend>
          <ul class="space-y-2">
            @for (item of hire.checklist; track $index; let i = $index) {
              <li class="flex flex-wrap items-center gap-2">
                <select
                  class="input w-36"
                  [attr.aria-label]="'Categoria da tarefa ' + (i + 1)"
                  [(ngModel)]="item.category"
                  [ngModelOptions]="{ standalone: true }"
                >
                  @for (c of categories; track c[0]) {
                    <option [ngValue]="c[0]">{{ c[1] }}</option>
                  }
                </select>
                <input
                  class="input min-w-0 flex-1"
                  [attr.aria-label]="'Tarefa ' + (i + 1)"
                  [(ngModel)]="item.title"
                  [ngModelOptions]="{ standalone: true }"
                />
                <button
                  type="button"
                  class="btn-ghost px-2"
                  [attr.aria-label]="'Remover tarefa ' + (i + 1)"
                  (click)="hire.checklist.splice(i, 1)"
                >
                  <app-icon name="close" [size]="16" />
                </button>
              </li>
            }
          </ul>
          <button
            type="button"
            class="btn-ghost mt-2"
            (click)="hire.checklist.push({ category: 'OTHER', title: '' })"
          >
            <app-icon name="plus" [size]="16" />Adicionar tarefa
          </button>
        </fieldset>
      </div>
      <ng-container actions>
        <button type="button" class="btn-secondary" (click)="hireOpen.set(false)">Cancelar</button>
        <button
          type="button"
          class="btn-primary"
          data-testid="hire-confirm"
          [disabled]="dialog.busy()"
          (click)="confirmHire()"
        >
          Contratar
        </button>
      </ng-container>
    </app-modal>
  `,
})
export class ApplicationDetail {
  readonly id = input.required<string>();
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  private readonly toasts = inject(ToastService);
  private readonly confirm = inject(ConfirmService);
  private readonly breadcrumbs = inject(Breadcrumbs);
  private readonly workspace = inject(Workspace);
  protected readonly app = signal<Application | null>(null);
  protected readonly loadError = signal<ApiError | null>(null);
  protected readonly members = signal<Member[]>([]);
  protected readonly action = new Action();
  protected readonly dialog = new Action();
  protected readonly tone = tone;
  protected readonly date = formatDate;
  protected readonly dateTime = formatDateTime;
  protected readonly money = (v: string) => formatMoney(v);
  protected readonly stage = (s: Stage) => STAGE[s] ?? s;
  protected readonly stageActionLabel = (s: Stage) => STAGE_ACTION_LABEL[s];
  protected readonly mode = (m: Interview['mode']) => INTERVIEW_MODE[m];
  protected readonly interviewStatus = (s: Interview['status']) => INTERVIEW_STATUS[s];
  protected readonly offerStatus = (s: Offer['status']) => OFFER_STATUS[s];
  protected readonly recommendation = (r: keyof typeof RECOMMENDATION) => RECOMMENDATION[r];
  protected readonly canOffer = canOffer;
  protected readonly modes = Object.entries(INTERVIEW_MODE);
  protected readonly recommendations = Object.entries(RECOMMENDATION);
  protected readonly categories = Object.entries(ONBOARDING_CATEGORY);
  protected readonly offerActionLabel: Record<ReturnType<typeof offerActions>[number], string> = {
    edit: 'Alterar',
    submit: 'Pedir aprovação',
    approve: 'Aprovar',
    reject: 'Recusar',
    accept: 'Candidato aceitou',
    decline: 'Candidato recusou',
    cancel: 'Cancelar proposta',
    hire: 'Contratar',
  };

  protected readonly closed = computed(() =>
    ['HIRED', 'REJECTED', 'WITHDRAWN'].includes(this.app()?.stage ?? ''),
  );
  protected readonly stageActions = computed(() => STAGE_ACTIONS[this.app()?.stage ?? 'HIRED']);
  protected readonly doneInterviews = computed(() =>
    (this.app()?.interviews ?? []).filter((i) => i.status === 'DONE'),
  );

  protected readonly reasonFor = signal<{
    kind: 'stage' | 'reject-offer' | 'cancel-offer';
    stage?: Stage;
    offer?: Offer;
  } | null>(null);
  protected reason = '';
  protected readonly reasonRequired = computed(() => {
    const r = this.reasonFor();
    return r?.kind === 'reject-offer' || (r?.kind === 'stage' && r.stage === 'REJECTED');
  });
  protected readonly reasonTitle = computed(() => {
    const r = this.reasonFor();
    if (r?.kind === 'reject-offer') return 'Recusar proposta';
    if (r?.kind === 'cancel-offer') return 'Cancelar proposta';
    return r?.stage === 'WITHDRAWN' ? 'Registar desistência' : 'Recusar candidatura';
  });

  protected readonly interviewOpen = signal(false);
  protected iv = {
    at: '',
    duration: 60,
    mode: 'ONSITE',
    location: '',
    interviewer: null as string | null,
  };
  protected readonly evaluationOpen = signal(false);
  protected ev = {
    interviewId: null as string | null,
    score: 3,
    recommendation: 'HOLD',
    comments: '',
  };
  protected readonly offerOpen = signal(false);
  protected readonly offerEditing = signal<Offer | null>(null);
  protected of = { salary: null as string | null, startDate: '', expiresOn: '', conditions: '' };
  protected readonly hireOpen = signal(false);
  private hiring: Offer | null = null;
  protected hire = {
    code: '',
    hireDate: '',
    workEmail: '',
    checklist: [] as { category: OnboardingCategory; title: string }[],
  };

  constructor() {
    effect(() => {
      const id = this.id();
      untracked(() => void this.load(id));
    });
  }

  protected reload() {
    void this.load(this.id());
  }

  protected inRange() {
    const a = this.app();
    return !!a && withinRange(this.of.salary, a.requisition.salaryMin, a.requisition.salaryMax);
  }

  protected actionsFor(o: Offer) {
    const a = this.app()!;
    return offerActions(
      o,
      a.access ?? { manage: false, approve: false },
      a.offerApprovalMode ?? 'DIRECT',
    );
  }

  private async load(id: string) {
    this.loadError.set(null);
    try {
      const a = await this.api.get<Application>(`hr/applications/${id}`);
      this.app.set(a);
      this.breadcrumbs.setCurrent(a.candidate.fullName);
    } catch (error) {
      this.loadError.set(ApiError.from(error));
    }
  }

  private async refresh(message: string) {
    await this.load(this.id());
    this.toasts.show(message);
  }

  protected async changeStage(stage: Stage) {
    const a = this.app()!;
    if (stage === 'REJECTED' || stage === 'WITHDRAWN') {
      this.reason = '';
      this.action.error.set(null);
      this.reasonFor.set({ kind: 'stage', stage });
      return;
    }
    const done = await this.action.run(() =>
      this.api.post(`hr/applications/${a.id}/stage`, { stage, expectedVersion: a.version }),
    );
    if (!done) return void this.toasts.show(this.action.error()?.message ?? 'Erro.', 'error');
    await this.refresh(`Candidatura em ${this.stage(stage).toLowerCase()}.`);
  }

  protected async confirmReason() {
    const r = this.reasonFor()!;
    const a = this.app()!;
    const reason = this.reason.trim() || undefined;
    const done = await this.action.run(() => {
      if (r.kind === 'stage')
        return this.api.post(`hr/applications/${a.id}/stage`, {
          stage: r.stage,
          reason,
          expectedVersion: a.version,
        });
      if (r.kind === 'reject-offer')
        return this.api.post(`hr/offers/${r.offer!.id}/decision`, {
          decision: 'REJECT',
          reason,
          expectedVersion: r.offer!.version,
        });
      return this.api.post(`hr/offers/${r.offer!.id}/cancel`, {
        reason,
        expectedVersion: r.offer!.version,
      });
    });
    if (!done) return;
    this.reasonFor.set(null);
    await this.refresh(
      r.kind === 'stage'
        ? 'Candidatura encerrada.'
        : r.kind === 'reject-offer'
          ? 'Proposta recusada.'
          : 'Proposta cancelada.',
    );
  }

  protected async openInterview() {
    this.dialog.error.set(null);
    this.iv = { at: '', duration: 60, mode: 'ONSITE', location: '', interviewer: null };
    if (!this.members().length && this.workspace.can('members.read')) {
      try {
        const page = await this.api.page<{ id: string; fullName: string | null; email: string }>(
          'members',
          {
            status: 'ACTIVE',
            limit: 100,
          },
        );
        this.members.set(
          page.items.map((m) => ({
            id: m.id,
            label: m.fullName ? `${m.fullName} (${m.email})` : m.email,
          })),
        );
      } catch {
        this.members.set([]);
      }
    }
    this.interviewOpen.set(true);
  }

  protected async saveInterview() {
    const a = this.app()!;
    const at = this.iv.at ? new Date(this.iv.at) : null;
    const done = await this.dialog.run(() =>
      this.api.post(`hr/applications/${a.id}/interviews`, {
        scheduledAt: at && !Number.isNaN(at.getTime()) ? at.toISOString() : null,
        durationMinutes: Number(this.iv.duration) || 60,
        mode: this.iv.mode,
        location: this.iv.location || null,
        interviewerMembershipId: this.iv.interviewer,
      }),
    );
    if (!done) return;
    this.interviewOpen.set(false);
    await this.refresh('Entrevista marcada.');
  }

  protected async setInterview(i: Interview, status: 'DONE' | 'CANCELLED') {
    if (status === 'CANCELLED') {
      const ok = await this.confirm.ask({
        title: 'Cancelar entrevista',
        message: `Cancelar a entrevista de ${formatDateTime(i.scheduledAt)}?`,
        confirmLabel: 'Cancelar entrevista',
        danger: true,
      });
      if (!ok) return;
    }
    const done = await this.action.run(() =>
      this.api.patch(`hr/interviews/${i.id}`, { status, expectedVersion: i.version }),
    );
    if (!done) return void this.toasts.show(this.action.error()?.message ?? 'Erro.', 'error');
    await this.refresh(status === 'DONE' ? 'Entrevista realizada.' : 'Entrevista cancelada.');
  }

  protected openEvaluation() {
    this.dialog.error.set(null);
    this.ev = { interviewId: null, score: 3, recommendation: 'HOLD', comments: '' };
    this.evaluationOpen.set(true);
  }

  protected async saveEvaluation() {
    const a = this.app()!;
    const done = await this.dialog.run(() =>
      this.api.post(`hr/applications/${a.id}/evaluations`, {
        interviewId: this.ev.interviewId ?? undefined,
        score: Number(this.ev.score),
        recommendation: this.ev.recommendation,
        comments: this.ev.comments || null,
      }),
    );
    if (!done) return;
    this.evaluationOpen.set(false);
    await this.refresh('Avaliação registada.');
  }

  protected openOffer(o: Offer | null) {
    this.dialog.error.set(null);
    this.offerEditing.set(o);
    this.of = o
      ? {
          salary: o.salary,
          startDate: o.startDate,
          expiresOn: o.expiresOn ?? '',
          conditions: o.conditions ?? '',
        }
      : { salary: null, startDate: '', expiresOn: '', conditions: '' };
    this.offerOpen.set(true);
  }

  protected async saveOffer() {
    const a = this.app()!;
    const editing = this.offerEditing();
    const body = {
      salary: this.of.salary,
      startDate: this.of.startDate || null,
      expiresOn: this.of.expiresOn || null,
      conditions: this.of.conditions || null,
    };
    const done = await this.dialog.run(() =>
      editing
        ? this.api.patch(`hr/offers/${editing.id}`, { ...body, expectedVersion: editing.version })
        : this.api.post(`hr/applications/${a.id}/offers`, body),
    );
    if (!done) return;
    this.offerOpen.set(false);
    await this.refresh(editing ? 'Proposta alterada.' : 'Proposta preparada em rascunho.');
  }

  protected async offerAction(o: Offer, act: ReturnType<typeof offerActions>[number]) {
    if (act === 'edit') return this.openOffer(o);
    if (act === 'reject' || act === 'cancel') {
      this.reason = '';
      this.action.error.set(null);
      this.reasonFor.set({ kind: act === 'reject' ? 'reject-offer' : 'cancel-offer', offer: o });
      return;
    }
    if (act === 'hire') {
      this.hiring = o;
      this.dialog.error.set(null);
      this.hire = {
        code: '',
        hireDate: o.startDate,
        workEmail: '',
        checklist: suggestedChecklist(),
      };
      this.hireOpen.set(true);
      return;
    }
    const call = {
      submit: () => this.api.post(`hr/offers/${o.id}/submit`, { expectedVersion: o.version }),
      approve: () =>
        this.api.post(`hr/offers/${o.id}/decision`, {
          decision: 'APPROVE',
          expectedVersion: o.version,
        }),
      accept: () =>
        this.api.post(`hr/offers/${o.id}/response`, { accepted: true, expectedVersion: o.version }),
      decline: () =>
        this.api.post(`hr/offers/${o.id}/response`, {
          accepted: false,
          expectedVersion: o.version,
        }),
    }[act];
    const message = {
      submit: 'Proposta enviada para aprovação.',
      approve: 'Proposta aprovada.',
      accept: 'Aceitação registada.',
      decline: 'Recusa do candidato registada.',
    }[act];
    const done = await this.action.run(call);
    if (!done) return void this.toasts.show(this.action.error()?.message ?? 'Erro.', 'error');
    await this.refresh(message);
  }

  protected async confirmHire() {
    const o = this.hiring!;
    const result = await this.dialog.run(() =>
      this.api.post<{ employeeId: string }>(`hr/offers/${o.id}/hire`, {
        code: this.hire.code,
        hireDate: this.hire.hireDate || undefined,
        workEmail: this.hire.workEmail || null,
        checklist: this.hire.checklist.filter((i) => i.title.trim()),
        expectedVersion: o.version,
      }),
    );
    if (!result) return;
    this.hireOpen.set(false);
    this.toasts.show('Colaborador criado e onboarding iniciado.');
    await this.router.navigate(['/rh/colaboradores', result.employeeId]);
  }

  protected active = activeOffer;
}
