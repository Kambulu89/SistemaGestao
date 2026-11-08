import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { Api, ApiError } from '../core/api';
import { Breadcrumbs } from '../core/breadcrumbs';
import { type HasUnsavedChanges, snapshot, warnOnUnload } from '../core/unsaved';
import { AuditHistory } from '../ui/audit-history';
import { ConfirmService } from '../ui/confirm';
import { formatDate, formatDateTime } from '../ui/dates';
import { FieldList } from '../ui/detail-drawer';
import { ErrorAlert } from '../ui/error-alert';
import { FormActionBar } from '../ui/form-action-bar';
import { FieldControl, FormField, FormSection } from '../ui/form-field';
import { Action } from '../ui/load';
import { Modal } from '../ui/modal';
import { formatMoney, MoneyInput } from '../ui/money-input';
import { PageDetail } from '../ui/page-detail';
import { ErrorState, Skeleton } from '../ui/states';
import { ToastService } from '../ui/toasts';
import {
  amendmentSummary,
  type Contract,
  type ContractAction,
  CONTRACT_EVENT,
  CONTRACT_STATUS,
  CONTRACT_TYPE,
  contractActions,
  contractPayload,
} from './contracts-model';

const EDITABLE = [
  'code',
  'contractType',
  'startDate',
  'endDate',
  'probationEndDate',
  'weeklyHours',
  'workSchedule',
  'currency',
  'baseSalary',
  'notes',
] as const;

/**
 * Contrato de trabalho: rascunho editável; em vigor só muda por adenda ou renovação (com data de efeito, sem reescrever
 * o passado); suspender, retomar e terminar com data e motivo. Condições em vigor hoje e histórico de eventos.
 */
@Component({
  selector: 'app-contract-detail',
  imports: [
    FormsModule,
    RouterLink,
    PageDetail,
    FormSection,
    FormField,
    FieldControl,
    FormActionBar,
    FieldList,
    AuditHistory,
    Modal,
    MoneyInput,
    ErrorAlert,
    ErrorState,
    Skeleton,
  ],
  template: `
    @if (loadError()) {
      <app-error-state [error]="loadError()" (retry)="reload()" />
    } @else if (!c()) {
      <div class="card"><app-skeleton /></div>
    } @else {
      @let k = c()!;
      <app-page-detail
        [title]="'Contrato ' + k.code"
        [subtitle]="k.employee?.fullName + ' · ' + type(k.contractType)"
      >
        <ng-container actions>
          @if (k.employee) {
            <a class="btn-secondary" [routerLink]="['/rh/colaboradores', k.employee.id]"
              >Ver colaborador</a
            >
          }
          @for (a of actions(); track a) {
            @if (a !== 'edit') {
              <button
                type="button"
                [class]="a === 'activate' ? 'btn-primary' : 'btn-secondary'"
                [attr.data-testid]="'ct-' + a"
                (click)="run(a)"
              >
                {{ actionLabel[a] }}
              </button>
            }
          }
        </ng-container>

        <p class="mb-4">
          <span class="badge" [class]="tone()" data-testid="ct-status">{{ status(k.status) }}</span>
        </p>
        @if (k.termExceeded) {
          <p class="mb-4 rounded-card bg-warning-soft p-3 text-sm text-warning-text" role="status">
            O termo ({{ date(k.currentTerms.endDate) }}) já passou e o contrato continua em vigor:
            renove-o ou termine-o.
          </p>
        }

        <form id="ct-form" class="space-y-4" (ngSubmit)="save()" novalidate>
          <app-form-section
            title="Condições iniciais"
            [description]="
              editable()
                ? 'Rascunho: pode alterar antes de activar.'
                : 'Como foram contratadas; as alterações estão nas adendas.'
            "
          >
            <app-field label="Número" [required]="true" [error]="action.field('code')">
              <input
                appControl
                class="input"
                [disabled]="!editable()"
                [(ngModel)]="form['code']"
                [ngModelOptions]="{ standalone: true }"
                (ngModelChange)="touch()"
              />
            </app-field>
            <app-field label="Tipo" [required]="true" [error]="action.field('contractType')">
              <select
                appControl
                class="input"
                [disabled]="!editable()"
                [(ngModel)]="form['contractType']"
                [ngModelOptions]="{ standalone: true }"
                (ngModelChange)="touch()"
              >
                @for (t of types; track t[0]) {
                  <option [value]="t[0]">{{ t[1] }}</option>
                }
              </select>
            </app-field>
            <app-field label="Início" [required]="true" [error]="action.field('startDate')">
              <input
                appControl
                class="input"
                type="date"
                [disabled]="!editable()"
                [(ngModel)]="form['startDate']"
                [ngModelOptions]="{ standalone: true }"
                (ngModelChange)="touch()"
              />
            </app-field>
            <app-field label="Termo" [error]="action.field('endDate')">
              <input
                appControl
                class="input"
                type="date"
                [disabled]="!editable()"
                [(ngModel)]="form['endDate']"
                [ngModelOptions]="{ standalone: true }"
                (ngModelChange)="touch()"
              />
            </app-field>
            <app-field
              label="Fim do período experimental"
              [error]="action.field('probationEndDate')"
            >
              <input
                appControl
                class="input"
                type="date"
                [disabled]="!editable()"
                [(ngModel)]="form['probationEndDate']"
                [ngModelOptions]="{ standalone: true }"
                (ngModelChange)="touch()"
              />
            </app-field>
            <app-field
              label="Horas semanais"
              [required]="true"
              [error]="action.field('weeklyHours')"
            >
              <input
                appControl
                class="input"
                inputmode="decimal"
                [disabled]="!editable()"
                [(ngModel)]="form['weeklyHours']"
                [ngModelOptions]="{ standalone: true }"
                (ngModelChange)="touch()"
              />
            </app-field>
            <app-field label="Horário" [error]="action.field('workSchedule')">
              <input
                appControl
                class="input"
                [disabled]="!editable()"
                [(ngModel)]="form['workSchedule']"
                [ngModelOptions]="{ standalone: true }"
                (ngModelChange)="touch()"
              />
            </app-field>
            <app-field
              label="Remuneração base (mensal)"
              [required]="true"
              [error]="action.field('baseSalary')"
            >
              <app-money-input
                [currency]="k.currency"
                [disabled]="!editable()"
                [(ngModel)]="form['baseSalary']"
                [ngModelOptions]="{ standalone: true }"
                (ngModelChange)="touch()"
              />
            </app-field>
            <app-field label="Notas" [error]="action.field('notes')">
              <textarea
                appControl
                class="input min-h-20"
                [disabled]="!editable()"
                [(ngModel)]="form['notes']"
                [ngModelOptions]="{ standalone: true }"
                (ngModelChange)="touch()"
              ></textarea>
            </app-field>
          </app-form-section>
          @if (editable()) {
            <app-form-action-bar
              formId="ct-form"
              [dirty]="hasUnsavedChanges()"
              [busy]="action.busy()"
            />
          }
        </form>

        <section class="card mt-4" aria-labelledby="ct-amendments">
          <h2 id="ct-amendments" class="mb-3 font-semibold">Adendas e renovações</h2>
          @if (k.amendments?.length) {
            <ol class="space-y-2 text-sm">
              @for (a of k.amendments; track a.id) {
                <li data-testid="amendment">
                  <p class="font-medium">
                    {{ a.kind === 'RENEWAL' ? 'Renovação' : 'Adenda' }} n.º {{ a.sequence }} ·
                    efeito {{ date(a.effectiveDate) }}
                  </p>
                  <p>{{ summary(a, k.currency) }}</p>
                  <p class="text-xs text-muted">{{ a.reason }}</p>
                </li>
              }
            </ol>
          } @else {
            <p class="text-sm text-muted">Sem adendas.</p>
          }
        </section>

        <div aside>
          <section class="card" aria-labelledby="ct-terms">
            <h2 id="ct-terms" class="mb-3 font-semibold">Em vigor hoje</h2>
            <app-field-list
              data-testid="ct-terms"
              [fields]="[
                {
                  label: 'Remuneração base',
                  value: money(k.currentTerms.baseSalary) + ' ' + k.currency,
                },
                { label: 'Horas semanais', value: k.currentTerms.weeklyHours },
                { label: 'Horário', value: k.currentTerms.workSchedule },
                {
                  label: 'Termo',
                  value: k.currentTerms.endDate ? date(k.currentTerms.endDate) : 'Sem termo',
                },
                { label: 'Renovações', value: k.renewalCount },
                { label: 'Suspenso desde', value: k.suspendedFrom ? date(k.suspendedFrom) : null },
                {
                  label: 'Terminado em',
                  value: k.terminationDate
                    ? date(k.terminationDate) + ' — ' + k.terminationReason
                    : null,
                },
              ]"
            />
          </section>
          <section class="card" aria-labelledby="ct-events">
            <h2 id="ct-events" class="mb-3 font-semibold">Eventos do contrato</h2>
            <ol class="space-y-2 text-sm">
              @for (e of k.events ?? []; track $index) {
                <li data-testid="ct-event">
                  <p class="font-medium">{{ event(e.kind) }} · {{ date(e.date) }}</p>
                  @if (e.reason) {
                    <p class="text-muted">{{ e.reason }}</p>
                  }
                </li>
              } @empty {
                <li class="text-muted">Ainda em rascunho.</li>
              }
            </ol>
          </section>
          <app-audit-history
            entityType="employment_contract"
            [entityId]="k.id"
            [refreshKey]="k.version"
          />
        </div>
      </app-page-detail>
    }

    <!-- Adenda / renovação -->
    <app-modal
      [title]="amendKind() === 'RENEWAL' ? 'Renovar contrato' : 'Nova adenda'"
      [open]="amendKind() !== null"
      (closed)="amendKind.set(null)"
    >
      <app-error-alert [error]="dialog.error()" [showDetails]="false" />
      <p class="mb-3 text-sm text-muted">
        Preencha só o que muda. A data de efeito não pode ser anterior à última adenda.
      </p>
      <div class="space-y-3">
        <app-field label="Data de efeito" [required]="true" [error]="dialog.field('effectiveDate')">
          <input
            appControl
            class="input"
            type="date"
            data-testid="am-date"
            [(ngModel)]="am.effectiveDate"
            [ngModelOptions]="{ standalone: true }"
          />
        </app-field>
        @if (amendKind() === 'CHANGE') {
          <app-field label="Nova remuneração base" [error]="dialog.field('baseSalary')">
            <app-money-input
              data-testid="am-salary"
              [currency]="c()?.currency ?? 'AOA'"
              [(ngModel)]="am.baseSalary"
              [ngModelOptions]="{ standalone: true }"
            />
          </app-field>
          <app-field label="Novas horas semanais" [error]="dialog.field('weeklyHours')">
            <input
              appControl
              class="input"
              inputmode="decimal"
              [(ngModel)]="am.weeklyHours"
              [ngModelOptions]="{ standalone: true }"
            />
          </app-field>
          <app-field label="Novo horário" [error]="dialog.field('workSchedule')">
            <input
              appControl
              class="input"
              [(ngModel)]="am.workSchedule"
              [ngModelOptions]="{ standalone: true }"
            />
          </app-field>
        }
        @if (amendKind() === 'RENEWAL' || c()?.contractType !== 'PERMANENT') {
          <app-field
            [label]="amendKind() === 'RENEWAL' ? 'Novo termo' : 'Novo termo (opcional)'"
            [required]="amendKind() === 'RENEWAL'"
            [error]="dialog.field('endDate')"
          >
            <input
              appControl
              class="input"
              type="date"
              data-testid="am-end"
              [(ngModel)]="am.endDate"
              [ngModelOptions]="{ standalone: true }"
            />
          </app-field>
        }
        <app-field label="Motivo" [required]="true" [error]="dialog.field('reason')">
          <textarea
            appControl
            class="input min-h-20"
            data-testid="am-reason"
            [(ngModel)]="am.reason"
            [ngModelOptions]="{ standalone: true }"
          ></textarea>
        </app-field>
      </div>
      <ng-container actions>
        <button type="button" class="btn-secondary" (click)="amendKind.set(null)">Cancelar</button>
        <button
          type="button"
          class="btn-primary"
          data-testid="am-confirm"
          [disabled]="dialog.busy()"
          (click)="saveAmendment()"
        >
          Registar
        </button>
      </ng-container>
    </app-modal>

    <!-- Suspender / retomar / terminar -->
    <app-modal
      [title]="datedTitle()"
      [open]="datedAction() !== null"
      (closed)="datedAction.set(null)"
    >
      <app-error-alert [error]="dialog.error()" [showDetails]="false" />
      <div class="space-y-3">
        <app-field label="Data" [required]="true" [error]="dialog.field('date')">
          <input
            appControl
            class="input"
            type="date"
            data-testid="dt-date"
            [(ngModel)]="dated.date"
            [ngModelOptions]="{ standalone: true }"
          />
        </app-field>
        <app-field
          label="Motivo"
          [required]="datedAction() !== 'resume'"
          [error]="dialog.field('reason')"
        >
          <textarea
            appControl
            class="input min-h-20"
            data-testid="dt-reason"
            [(ngModel)]="dated.reason"
            [ngModelOptions]="{ standalone: true }"
          ></textarea>
        </app-field>
      </div>
      <ng-container actions>
        <button type="button" class="btn-secondary" (click)="datedAction.set(null)">
          Cancelar
        </button>
        <button
          type="button"
          class="btn-primary"
          data-testid="dt-confirm"
          [disabled]="dialog.busy()"
          (click)="saveDated()"
        >
          Confirmar
        </button>
      </ng-container>
    </app-modal>
  `,
})
export class ContractDetail implements HasUnsavedChanges {
  readonly id = input.required<string>();
  private readonly api = inject(Api);
  private readonly toasts = inject(ToastService);
  private readonly confirm = inject(ConfirmService);
  private readonly breadcrumbs = inject(Breadcrumbs);
  protected readonly c = signal<Contract | null>(null);
  protected readonly loadError = signal<ApiError | null>(null);
  protected readonly action = new Action();
  protected readonly dialog = new Action();
  protected readonly date = (v: string | null) => formatDate(v);
  protected readonly dateTime = formatDateTime;
  protected readonly money = (v: string) => formatMoney(v);
  protected readonly type = (t: keyof typeof CONTRACT_TYPE) => CONTRACT_TYPE[t];
  protected readonly status = (s: keyof typeof CONTRACT_STATUS) => CONTRACT_STATUS[s];
  protected readonly event = (k: string) => CONTRACT_EVENT[k] ?? k;
  protected readonly types = Object.entries(CONTRACT_TYPE);
  protected readonly summary = (a: Parameters<typeof amendmentSummary>[0], currency: string) =>
    amendmentSummary(a, currency, (v) => formatMoney(v), formatDate);
  protected readonly actionLabel: Record<ContractAction, string> = {
    edit: 'Alterar',
    activate: 'Activar',
    cancel: 'Cancelar rascunho',
    amend: 'Nova adenda',
    renew: 'Renovar',
    suspend: 'Suspender',
    resume: 'Retomar',
    terminate: 'Terminar',
  };
  private readonly tick = signal(0);
  protected form: Record<string, unknown> = {};
  private initial = '';
  protected readonly actions = computed(() => {
    const k = this.c();
    return k ? contractActions(k, !!k.access?.manage) : [];
  });
  protected readonly editable = computed(() => this.actions().includes('edit'));
  protected readonly tone = computed(() => {
    const s = this.c()?.status;
    return s === 'ACTIVE'
      ? 'bg-success-soft text-success-text'
      : s === 'SUSPENDED'
        ? 'bg-warning-soft text-warning-text'
        : s === 'DRAFT'
          ? 'bg-info-soft text-info-text'
          : 'bg-surface-2 text-muted';
  });
  protected readonly amendKind = signal<'CHANGE' | 'RENEWAL' | null>(null);
  protected am = {
    effectiveDate: '',
    baseSalary: null as string | null,
    weeklyHours: '',
    workSchedule: '',
    endDate: '',
    reason: '',
  };
  protected readonly datedAction = signal<'suspend' | 'resume' | 'terminate' | null>(null);
  protected dated = { date: '', reason: '' };
  protected readonly datedTitle = computed(
    () =>
      ({
        suspend: 'Suspender contrato',
        resume: 'Retomar contrato',
        terminate: 'Terminar contrato',
      })[this.datedAction() ?? 'suspend'],
  );

  constructor() {
    warnOnUnload(this);
    effect(() => {
      const id = this.id();
      untracked(() => void this.load(id));
    });
  }

  hasUnsavedChanges() {
    this.tick();
    return this.editable() && snapshot(this.form) !== this.initial;
  }

  protected touch() {
    this.tick.update((n) => n + 1);
  }

  protected reload() {
    void this.load(this.id());
  }

  private async load(id: string) {
    this.loadError.set(null);
    try {
      const k = await this.api.get<Contract>(`hr/contracts/${id}`);
      this.c.set(k);
      this.breadcrumbs.setCurrent(`Contrato ${k.code}`);
      this.form = Object.fromEntries(EDITABLE.map((f) => [f, k[f] ?? null]));
      this.initial = snapshot(this.form);
      this.touch();
    } catch (error) {
      this.loadError.set(ApiError.from(error));
    }
  }

  protected async save() {
    const k = this.c()!;
    const body = contractPayload(
      this.form,
      Object.fromEntries(EDITABLE.map((f) => [f, k[f] ?? null])),
    );
    if (!Object.keys(body).length) return void this.toasts.show('Nada para guardar.', 'info');
    const done = await this.action.run(() =>
      this.api.patch(`hr/contracts/${k.id}`, { ...body, expectedVersion: k.version }),
    );
    if (!done) return;
    this.initial = snapshot(this.form);
    await this.load(k.id);
    this.toasts.show('Contrato actualizado.');
  }

  protected async run(a: ContractAction) {
    const k = this.c()!;
    const today = new Date().toISOString().slice(0, 10);
    if (a === 'amend' || a === 'renew') {
      this.dialog.error.set(null);
      this.am = {
        effectiveDate: today,
        baseSalary: null,
        weeklyHours: '',
        workSchedule: '',
        endDate: '',
        reason: '',
      };
      this.amendKind.set(a === 'renew' ? 'RENEWAL' : 'CHANGE');
      return;
    }
    if (a === 'suspend' || a === 'resume' || a === 'terminate') {
      this.dialog.error.set(null);
      this.dated = { date: today, reason: '' };
      this.datedAction.set(a);
      return;
    }
    if (this.hasUnsavedChanges())
      return void this.toasts.show('Guarde as alterações primeiro.', 'info');
    const ok = await this.confirm.ask({
      title: a === 'activate' ? 'Activar contrato' : 'Cancelar rascunho',
      message:
        a === 'activate'
          ? `Activar o contrato ${k.code}? Depois só muda por adenda.`
          : `Cancelar o rascunho ${k.code}?`,
      confirmLabel: a === 'activate' ? 'Activar' : 'Cancelar rascunho',
      danger: a === 'cancel',
    });
    if (!ok) return;
    const done = await this.action.run(() =>
      this.api.post(`hr/contracts/${k.id}/${a}`, { expectedVersion: k.version }),
    );
    if (!done) return void this.toasts.show(this.action.error()?.message ?? 'Erro.', 'error');
    await this.load(k.id);
    this.toasts.show(a === 'activate' ? 'Contrato activado.' : 'Rascunho cancelado.');
  }

  protected async saveAmendment() {
    const k = this.c()!;
    const kind = this.amendKind()!;
    const done = await this.dialog.run(() =>
      this.api.post(`hr/contracts/${k.id}/amendments`, {
        kind,
        effectiveDate: this.am.effectiveDate,
        baseSalary: kind === 'CHANGE' ? this.am.baseSalary || null : null,
        weeklyHours: kind === 'CHANGE' ? this.am.weeklyHours || null : null,
        workSchedule: kind === 'CHANGE' ? this.am.workSchedule || null : null,
        endDate: this.am.endDate || null,
        reason: this.am.reason,
        expectedVersion: k.version,
      }),
    );
    if (!done) return;
    this.amendKind.set(null);
    await this.load(k.id);
    this.toasts.show(kind === 'RENEWAL' ? 'Contrato renovado.' : 'Adenda registada.');
  }

  protected async saveDated() {
    const k = this.c()!;
    const a = this.datedAction()!;
    const done = await this.dialog.run(() =>
      this.api.post(`hr/contracts/${k.id}/${a}`, {
        date: this.dated.date,
        reason: this.dated.reason || undefined,
        expectedVersion: k.version,
      }),
    );
    if (!done) return;
    this.datedAction.set(null);
    await this.load(k.id);
    this.toasts.show(
      {
        suspend: 'Contrato suspenso.',
        resume: 'Contrato retomado.',
        terminate: 'Contrato terminado.',
      }[a],
    );
  }
}
