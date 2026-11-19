import { NgTemplateOutlet } from '@angular/common';
import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { Api, ApiError } from '../core/api';
import { Breadcrumbs } from '../core/breadcrumbs';
import { type HasUnsavedChanges, snapshot, warnOnUnload } from '../core/unsaved';
import { Workspace } from '../core/workspace';
import { AuditHistory } from '../ui/audit-history';
import { ConfirmService } from '../ui/confirm';
import { CellDef, type Column, DataTable } from '../ui/data-table';
import { formatDate } from '../ui/dates';
import { FieldList } from '../ui/detail-drawer';
import { ErrorAlert } from '../ui/error-alert';
import { FormActionBar } from '../ui/form-action-bar';
import { FieldControl, FormField, FormSection } from '../ui/form-field';
import { Icon } from '../ui/icon';
import { Action } from '../ui/load';
import { Modal } from '../ui/modal';
import { formatMoney, MoneyInput } from '../ui/money-input';
import { PageDetail } from '../ui/page-detail';
import { ErrorState, Skeleton } from '../ui/states';
import { EntityFormPage } from '../ui/templates';
import { ToastService } from '../ui/toasts';
import {
  type Application,
  type Candidate,
  type Requisition,
  REQUISITION_STATUS,
  requisitionPayload,
  STAGE,
  type Stage,
  tone,
} from './recruitment-model';

interface Option {
  id: string;
  label: string;
  legalEntityId?: string | null;
  departmentId?: string | null;
  branchId?: string | null;
}

/**
 * Vaga: criar, alterar em rascunho, pedir aprovação, aprovar/recusar (decisão directa ou pelo workflow configurado),
 * fechar ou cancelar; e as candidaturas da vaga. A API decide o âmbito e a segregação (quem pede não aprova).
 */
@Component({
  selector: 'app-requisition-form',
  imports: [
    FormsModule,
    RouterLink,
    NgTemplateOutlet,
    PageDetail,
    EntityFormPage,
    FormSection,
    FormField,
    FieldControl,
    FormActionBar,
    FieldList,
    AuditHistory,
    DataTable,
    CellDef,
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
    } @else if (isNew()) {
      <app-entity-form-page
        title="Nova vaga"
        subtitle="A vaga fica em rascunho até ser aprovada. A remuneração aprovada limita as propostas."
        formId="req-form"
        [loading]="!loaded()"
        [saveError]="action.error()"
        [busy]="action.busy()"
        [dirty]="hasUnsavedChanges()"
        saveLabel="Criar vaga"
        (save)="save()"
        (cancelled)="back()"
      >
        <ng-container *ngTemplateOutlet="fieldsTpl" />
      </app-entity-form-page>
    } @else if (!loaded() || !record()) {
      <div class="card"><app-skeleton /></div>
    } @else {
      @let r = record()!;
      <app-page-detail
        [title]="r.code + ' — ' + r.title"
        [subtitle]="subtitle()"
        [status]="r.status"
      >
        <ng-container actions>
          <a class="btn-secondary" routerLink="/rh/vagas">Voltar à lista</a>
          @if (manage() && r.status === 'DRAFT') {
            <button type="button" class="btn-primary" data-testid="req-submit" (click)="submit()">
              Pedir aprovação
            </button>
          }
          @if (
            r.status === 'PENDING_APPROVAL' && r.approvalMode === 'DIRECT' && r.access?.approve
          ) {
            <button
              type="button"
              class="btn-primary"
              data-testid="req-approve"
              (click)="decide('APPROVE')"
            >
              Aprovar
            </button>
            <button type="button" class="btn-secondary" (click)="openReason('REJECT')">
              Recusar
            </button>
          }
          @if (r.status === 'PENDING_APPROVAL' && r.approvalRequestId) {
            <a class="btn-secondary" [routerLink]="['/aprovacoes/pedidos', r.approvalRequestId]"
              >Ver pedido de aprovação</a
            >
          }
          @if (manage() && r.status === 'OPEN') {
            <button type="button" class="btn-secondary" (click)="openReason('CLOSE')">
              Fechar vaga
            </button>
          }
          @if (manage() && (r.status === 'OPEN' || r.status === 'DRAFT')) {
            <button type="button" class="btn-secondary" (click)="openReason('CANCEL')">
              Cancelar
            </button>
          }
        </ng-container>

        @if (r.rejectionReason && r.status === 'DRAFT') {
          <div
            class="mb-4 rounded-card bg-warning-soft p-3 text-sm text-warning-text"
            role="status"
          >
            <strong>Recusada:</strong> {{ r.rejectionReason }}
          </div>
        }
        @if (r.status === 'PENDING_APPROVAL' && r.approvalMode === 'DIRECT' && !r.access?.approve) {
          <p class="mb-4 text-sm text-muted" role="status">
            Aguarda a decisão de quem aprova vagas nesta entidade (nunca quem a pediu).
          </p>
        }

        <form id="req-form" class="space-y-4" (ngSubmit)="save()" novalidate>
          <ng-container *ngTemplateOutlet="fieldsTpl" />
          @if (editable()) {
            <app-form-action-bar
              formId="req-form"
              [dirty]="hasUnsavedChanges()"
              [busy]="action.busy()"
            />
          }
        </form>

        <section class="card mt-4" aria-labelledby="req-apps">
          <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h2 id="req-apps" class="font-semibold">Candidaturas</h2>
            @if (manage() && r.status === 'OPEN') {
              <button
                type="button"
                class="btn-secondary"
                data-testid="add-application"
                (click)="openApply()"
              >
                <app-icon name="plus" [size]="16" />Adicionar candidato
              </button>
            }
          </div>
          <app-data-table
            label="Candidaturas da vaga"
            [columns]="appColumns"
            [rows]="applications()"
            [total]="applications().length"
            [loading]="false"
            [offset]="0"
            [limit]="200"
            emptyText="Ainda não há candidaturas."
          >
            <ng-template appCell="stage" let-row>
              <span class="badge" [class]="tone(row.stage)">{{ stageLabel(row.stage) }}</span>
            </ng-template>
          </app-data-table>
        </section>

        <div aside>
          <section class="card" aria-labelledby="req-summary">
            <h2 id="req-summary" class="mb-3 font-semibold">Resumo</h2>
            <app-field-list
              [fields]="[
                { label: 'Entidade legal', value: r.legalEntity.code + ' — ' + r.legalEntity.name },
                { label: 'Cargo', value: r.position.code + ' — ' + r.position.name },
                { label: 'Postos preenchidos', value: r.hiredCount + ' de ' + r.quantity },
                {
                  label: 'Remuneração autorizada',
                  value: money(r.salaryMin) + ' – ' + money(r.salaryMax) + ' ' + r.currency,
                },
                { label: 'Prazo', value: date(r.deadline) },
                {
                  label: 'Aprovação',
                  value: r.approvalMode === 'WORKFLOW' ? 'Workflow configurado' : 'Decisão directa',
                },
              ]"
            />
          </section>
          <app-audit-history
            entityType="job_requisition"
            [entityId]="r.id"
            [refreshKey]="r.version"
          />
        </div>
      </app-page-detail>
    }

    <ng-template #fieldsTpl>
      <app-form-section
        title="Vaga"
        description="Identificação e colocação na estrutura (mesma entidade legal)."
      >
        <app-field label="Código" [required]="true" [error]="action.field('code')">
          <input
            appControl
            class="input"
            data-field="code"
            [disabled]="!editable()"
            [(ngModel)]="form['code']"
            [ngModelOptions]="{ standalone: true }"
            (ngModelChange)="touch()"
          />
        </app-field>
        <app-field label="Título" [required]="true" [error]="action.field('title')">
          <input
            appControl
            class="input"
            data-field="title"
            [disabled]="!editable()"
            [(ngModel)]="form['title']"
            [ngModelOptions]="{ standalone: true }"
            (ngModelChange)="touch()"
          />
        </app-field>
        <app-field label="Entidade legal" [required]="true" [error]="action.field('legalEntityId')">
          <select
            appControl
            class="input"
            data-field="legalEntityId"
            [disabled]="!editable()"
            [ngModel]="form['legalEntityId'] ?? null"
            [ngModelOptions]="{ standalone: true }"
            (ngModelChange)="setPlacement('legalEntityId', $event)"
          >
            <option [ngValue]="null">—</option>
            @for (o of refs().legalEntities; track o.id) {
              <option [ngValue]="o.id">{{ o.label }}</option>
            }
          </select>
        </app-field>
        <app-field label="Filial" [error]="action.field('branchId')">
          <select
            appControl
            class="input"
            data-field="branchId"
            [disabled]="!editable()"
            [ngModel]="form['branchId'] ?? null"
            [ngModelOptions]="{ standalone: true }"
            (ngModelChange)="setPlacement('branchId', $event)"
          >
            <option [ngValue]="null">—</option>
            @for (o of byEntity(refs().branches); track o.id) {
              <option [ngValue]="o.id">{{ o.label }}</option>
            }
          </select>
        </app-field>
        <app-field label="Departamento" [error]="action.field('departmentId')">
          <select
            appControl
            class="input"
            data-field="departmentId"
            [disabled]="!editable()"
            [ngModel]="form['departmentId'] ?? null"
            [ngModelOptions]="{ standalone: true }"
            (ngModelChange)="setPlacement('departmentId', $event)"
          >
            <option [ngValue]="null">—</option>
            @for (o of byEntity(refs().departments); track o.id) {
              <option [ngValue]="o.id">{{ o.label }}</option>
            }
          </select>
        </app-field>
        <app-field label="Cargo" [required]="true" [error]="action.field('positionId')">
          <select
            appControl
            class="input"
            data-field="positionId"
            [disabled]="!editable()"
            [ngModel]="form['positionId'] ?? null"
            [ngModelOptions]="{ standalone: true }"
            (ngModelChange)="setPlacement('positionId', $event)"
          >
            <option [ngValue]="null">—</option>
            @for (o of positions(); track o.id) {
              <option [ngValue]="o.id">{{ o.label }}</option>
            }
          </select>
        </app-field>
      </app-form-section>
      <app-form-section
        title="Necessidade"
        description="Quantidade, prazo, requisitos e justificação."
      >
        <app-field
          label="Quantidade de postos"
          [required]="true"
          [error]="action.field('quantity')"
        >
          <input
            appControl
            class="input"
            type="number"
            min="1"
            data-field="quantity"
            [disabled]="!editable()"
            [(ngModel)]="form['quantity']"
            [ngModelOptions]="{ standalone: true }"
            (ngModelChange)="touch()"
          />
        </app-field>
        <app-field label="Prazo de recrutamento" [error]="action.field('deadline')">
          <input
            appControl
            class="input"
            type="date"
            data-field="deadline"
            [disabled]="!editable()"
            [(ngModel)]="form['deadline']"
            [ngModelOptions]="{ standalone: true }"
            (ngModelChange)="touch()"
          />
        </app-field>
        <app-field label="Requisitos" [error]="action.field('requirements')">
          <textarea
            appControl
            class="input min-h-24"
            data-field="requirements"
            [disabled]="!editable()"
            [(ngModel)]="form['requirements']"
            [ngModelOptions]="{ standalone: true }"
            (ngModelChange)="touch()"
          ></textarea>
        </app-field>
        <app-field label="Justificação" [error]="action.field('justification')">
          <textarea
            appControl
            class="input min-h-24"
            data-field="justification"
            [disabled]="!editable()"
            [(ngModel)]="form['justification']"
            [ngModelOptions]="{ standalone: true }"
            (ngModelChange)="touch()"
          ></textarea>
        </app-field>
      </app-form-section>
      <app-form-section
        title="Remuneração autorizada"
        description="Intervalo aprovado; as propostas têm de caber nele."
      >
        <app-field label="Moeda" [required]="true" [error]="action.field('currency')">
          <input
            appControl
            class="input uppercase"
            maxlength="3"
            data-field="currency"
            [disabled]="!editable()"
            [(ngModel)]="form['currency']"
            [ngModelOptions]="{ standalone: true }"
            (ngModelChange)="touch()"
          />
        </app-field>
        <app-field label="Mínimo" [required]="true" [error]="action.field('salaryMin')">
          <app-money-input
            data-field="salaryMin"
            [currency]="currencyLabel()"
            [(ngModel)]="form['salaryMin']"
            [ngModelOptions]="{ standalone: true }"
            [disabled]="!editable()"
            (ngModelChange)="touch()"
          />
        </app-field>
        <app-field label="Máximo" [required]="true" [error]="action.field('salaryMax')">
          <app-money-input
            data-field="salaryMax"
            [currency]="currencyLabel()"
            [(ngModel)]="form['salaryMax']"
            [ngModelOptions]="{ standalone: true }"
            [disabled]="!editable()"
            (ngModelChange)="touch()"
          />
        </app-field>
      </app-form-section>
    </ng-template>

    <app-modal [title]="reasonTitle()" [open]="reasonFor() !== null" (closed)="reasonFor.set(null)">
      <app-error-alert [error]="action.error()" />
      <app-field label="Motivo" [required]="reasonFor() === 'REJECT'">
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

    <app-modal
      title="Adicionar candidato à vaga"
      [open]="applying()"
      (closed)="applying.set(false)"
    >
      <app-error-alert [error]="apply.error()" />
      <div class="space-y-3">
        <app-field label="Candidato existente">
          <select
            appControl
            class="input"
            data-testid="apply-existing"
            [(ngModel)]="applyCandidateId"
            [ngModelOptions]="{ standalone: true }"
          >
            <option [ngValue]="null">— Novo candidato —</option>
            @for (c of candidates(); track c.id) {
              <option [ngValue]="c.id">
                {{ c.fullName }}{{ c.email ? ' (' + c.email + ')' : '' }}
              </option>
            }
          </select>
        </app-field>
        @if (!applyCandidateId) {
          <app-field label="Nome" [required]="true" [error]="apply.field('fullName')">
            <input
              appControl
              class="input"
              data-testid="apply-name"
              [(ngModel)]="newCandidate.fullName"
              [ngModelOptions]="{ standalone: true }"
            />
          </app-field>
          <app-field
            label="Email"
            [error]="apply.field('email')"
            hint="Indique um email ou um telefone."
          >
            <input
              appControl
              class="input"
              type="email"
              data-testid="apply-email"
              [(ngModel)]="newCandidate.email"
              [ngModelOptions]="{ standalone: true }"
            />
          </app-field>
          <app-field label="Telefone" [error]="apply.field('phone')">
            <input
              appControl
              class="input"
              data-testid="apply-phone"
              [(ngModel)]="newCandidate.phone"
              [ngModelOptions]="{ standalone: true }"
            />
          </app-field>
          <app-field label="Origem" [error]="apply.field('source')">
            <input
              appControl
              class="input"
              [(ngModel)]="newCandidate.source"
              [ngModelOptions]="{ standalone: true }"
            />
          </app-field>
        }
      </div>
      <ng-container actions>
        <button type="button" class="btn-secondary" (click)="applying.set(false)">Cancelar</button>
        <button
          type="button"
          class="btn-primary"
          data-testid="apply-confirm"
          [disabled]="apply.busy()"
          (click)="confirmApply()"
        >
          Adicionar
        </button>
      </ng-container>
    </app-modal>
  `,
})
export class RequisitionForm implements HasUnsavedChanges {
  readonly id = input.required<string>();
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  private readonly toasts = inject(ToastService);
  private readonly confirm = inject(ConfirmService);
  private readonly breadcrumbs = inject(Breadcrumbs);
  private readonly workspace = inject(Workspace);
  protected readonly isNew = computed(() => this.id() === 'nova');
  protected readonly record = signal<Requisition | null>(null);
  protected readonly applications = signal<Application[]>([]);
  protected readonly candidates = signal<Candidate[]>([]);
  protected readonly loaded = signal(false);
  protected readonly loadError = signal<ApiError | null>(null);
  protected readonly action = new Action();
  protected readonly apply = new Action();
  protected readonly date = formatDate;
  protected readonly money = (v: string) => formatMoney(v);
  protected readonly tone = tone;
  protected readonly stageLabel = (s: Stage) => STAGE[s] ?? s;
  protected readonly refs = signal<
    Record<'legalEntities' | 'branches' | 'departments' | 'positions', Option[]>
  >({
    legalEntities: [],
    branches: [],
    departments: [],
    positions: [],
  });
  private readonly tick = signal(0);
  protected form: Record<string, unknown> = {};
  private initial = '';
  protected readonly reasonFor = signal<'REJECT' | 'CLOSE' | 'CANCEL' | null>(null);
  protected reason = '';
  protected readonly applying = signal(false);
  protected applyCandidateId: string | null = null;
  protected newCandidate = { fullName: '', email: '', phone: '', source: '' };

  protected readonly manage = computed(() =>
    this.isNew() ? this.workspace.canAny('hr.recruitment.manage') : !!this.record()?.access?.manage,
  );
  protected readonly editable = computed(
    () => this.manage() && (this.isNew() || this.record()?.status === 'DRAFT'),
  );
  protected readonly subtitle = computed(() => {
    const r = this.record();
    return r
      ? [REQUISITION_STATUS[r.status], r.position.name, r.departmentName]
          .filter(Boolean)
          .join(' · ')
      : null;
  });
  protected readonly currencyLabel = computed(() => {
    this.tick();
    return String(this.form['currency'] ?? '').toUpperCase() || 'AOA';
  });
  protected readonly reasonTitle = computed(
    () =>
      ({ REJECT: 'Recusar vaga', CLOSE: 'Fechar vaga', CANCEL: 'Cancelar vaga' })[
        this.reasonFor() ?? 'CLOSE'
      ],
  );
  protected readonly positions = computed(() => {
    this.tick();
    const dept = this.form['departmentId'] as string | null;
    return this.refs().positions.filter((o) => !dept || !o.departmentId || o.departmentId === dept);
  });
  protected readonly appColumns: Column<Application>[] = [
    {
      key: 'candidate',
      label: 'Candidato',
      required: true,
      value: (a) => a.candidate.fullName,
      link: (a) => ['/rh/candidaturas', a.id],
    },
    { key: 'stage', label: 'Etapa', value: (a) => this.stageLabel(a.stage) },
    {
      key: 'averageScore',
      label: 'Avaliação média',
      align: 'end',
      value: (a) => a.averageScore ?? '—',
    },
    {
      key: 'createdAt',
      label: 'Recebida',
      hideOnMobile: true,
      value: (a) => formatDate(a.createdAt),
    },
  ];

  constructor() {
    warnOnUnload(this);
    effect(() => {
      const id = this.id();
      untracked(() => void this.load(id));
    });
  }

  hasUnsavedChanges() {
    this.tick();
    return this.loaded() && this.editable() && snapshot(this.form) !== this.initial;
  }

  protected touch() {
    this.tick.update((n) => n + 1);
  }

  protected reload() {
    void this.load(this.id());
  }

  protected byEntity(list: Option[]) {
    this.tick();
    const le = this.form['legalEntityId'] as string | null;
    return list.filter((o) => !le || o.legalEntityId === le);
  }

  protected setPlacement(key: string, value: unknown) {
    this.form = { ...this.form, [key]: value };
    if (key === 'legalEntityId')
      for (const k of ['branchId', 'departmentId', 'positionId']) this.form[k] = null;
    if (key === 'departmentId') this.form['positionId'] = null;
    this.touch();
  }

  private async load(id: string) {
    this.loaded.set(false);
    this.loadError.set(null);
    try {
      await this.loadRefs();
      if (id === 'nova') {
        this.record.set(null);
        this.form = {
          legalEntityId: this.workspace.legalEntityId() ?? null,
          quantity: 1,
          currency: 'AOA',
        };
      } else {
        const r = await this.api.get<Requisition>(`hr/requisitions/${id}`);
        this.record.set(r);
        this.breadcrumbs.setCurrent(r.code);
        this.form = { ...r };
        const apps = await this.api.page<Application>('hr/applications', {
          requisitionId: id,
          limit: 200,
        });
        this.applications.set(apps.items);
      }
      this.initial = snapshot(this.form);
      this.loaded.set(true);
      this.touch();
    } catch (error) {
      this.loadError.set(ApiError.from(error));
    }
  }

  private async loadRefs() {
    if (!this.workspace.can('organization.read')) return;
    interface Org {
      id: string;
      code: string;
      name?: string;
      legalName?: string;
      legalEntityId?: string;
      departmentId?: string | null;
    }
    const page = async (url: string) => {
      try {
        return (await this.api.page<Org>(url, { limit: 200 })).items.map((r) => ({
          id: r.id,
          label: `${r.code} — ${r.name ?? r.legalName ?? ''}`,
          legalEntityId: r.legalEntityId ?? null,
          departmentId: r.departmentId ?? null,
        }));
      } catch {
        return [];
      }
    };
    const [legalEntities, branches, departments, positions] = await Promise.all([
      page('organization/legal-entities'),
      page('organization/branches'),
      page('organization/departments'),
      page('organization/positions'),
    ]);
    this.refs.set({ legalEntities, branches, departments, positions });
  }

  protected back() {
    void this.router.navigate(['/rh/vagas']);
  }

  protected async save() {
    if (this.action.busy() || !this.editable()) return;
    const original = this.record();
    const body = requisitionPayload(this.form, original);
    if (original && Object.keys(body).length === 0) {
      this.toasts.show('Nada para guardar.', 'info');
      return;
    }
    const result = await this.action.run(() =>
      original
        ? this.api.patch<Requisition>(`hr/requisitions/${original.id}`, {
            ...body,
            expectedVersion: original.version,
          })
        : this.api.post<Requisition>('hr/requisitions', body),
    );
    if (!result) return;
    this.initial = snapshot(this.form);
    if (!original) {
      this.toasts.show('Vaga criada em rascunho.');
      await this.router.navigate(['/rh/vagas', result.id]);
      return;
    }
    await this.load(original.id);
    this.toasts.show('Vaga actualizada.');
  }

  protected async submit() {
    const r = this.record()!;
    if (this.hasUnsavedChanges()) {
      this.toasts.show('Guarde as alterações antes de pedir aprovação.', 'info');
      return;
    }
    const ok = await this.confirm.ask({
      title: 'Pedir aprovação',
      message: `Submeter a vaga ${r.code} para aprovação? Enquanto aguarda não se altera.`,
      confirmLabel: 'Pedir aprovação',
    });
    if (!ok) return;
    const done = await this.action.run(() =>
      this.api.post(`hr/requisitions/${r.id}/submit`, { expectedVersion: r.version }),
    );
    if (!done) {
      this.toasts.show(this.action.error()?.message ?? 'Não foi possível submeter.', 'error');
      return;
    }
    await this.load(r.id);
    this.toasts.show('Vaga enviada para aprovação.');
  }

  protected async decide(decision: 'APPROVE' | 'REJECT', reason?: string) {
    const r = this.record()!;
    const done = await this.action.run(() =>
      this.api.post(`hr/requisitions/${r.id}/decision`, {
        decision,
        reason: reason || undefined,
        expectedVersion: r.version,
      }),
    );
    if (!done) {
      if (decision === 'APPROVE')
        this.toasts.show(this.action.error()?.message ?? 'Erro.', 'error');
      return false;
    }
    await this.load(r.id);
    this.toasts.show(decision === 'APPROVE' ? 'Vaga aprovada e aberta.' : 'Vaga recusada.');
    return true;
  }

  protected openReason(kind: 'REJECT' | 'CLOSE' | 'CANCEL') {
    this.reason = '';
    this.action.error.set(null);
    this.reasonFor.set(kind);
  }

  protected async confirmReason() {
    const kind = this.reasonFor();
    const r = this.record()!;
    if (kind === 'REJECT') {
      if (await this.decide('REJECT', this.reason.trim())) this.reasonFor.set(null);
      return;
    }
    const done = await this.action.run(() =>
      this.api.post(`hr/requisitions/${r.id}/${kind === 'CLOSE' ? 'close' : 'cancel'}`, {
        reason: this.reason.trim() || undefined,
        expectedVersion: r.version,
      }),
    );
    if (!done) return;
    this.reasonFor.set(null);
    await this.load(r.id);
    this.toasts.show(kind === 'CLOSE' ? 'Vaga fechada.' : 'Vaga cancelada.');
  }

  protected async openApply() {
    this.apply.error.set(null);
    this.applyCandidateId = null;
    this.newCandidate = { fullName: '', email: '', phone: '', source: '' };
    try {
      this.candidates.set((await this.api.page<Candidate>('hr/candidates', { limit: 200 })).items);
    } catch {
      this.candidates.set([]);
    }
    this.applying.set(true);
  }

  protected async confirmApply() {
    const r = this.record()!;
    const result = await this.apply.run(async () => {
      let candidateId = this.applyCandidateId;
      if (!candidateId) {
        const n = this.newCandidate;
        const c = await this.api.post<Candidate>('hr/candidates', {
          fullName: n.fullName,
          email: n.email || null,
          phone: n.phone || null,
          source: n.source || null,
        });
        candidateId = c.id;
      }
      return this.api.post<Application>('hr/applications', { requisitionId: r.id, candidateId });
    });
    if (!result) return;
    this.applying.set(false);
    this.toasts.show('Candidatura registada.');
    await this.load(r.id);
  }
}
