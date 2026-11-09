import { Component, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { Api, ApiError } from '../core/api';
import { Breadcrumbs } from '../core/breadcrumbs';
import { Attachments } from '../ui/attachments';
import { ConfirmService } from '../ui/confirm';
import { formatDate } from '../ui/dates';
import { FieldList } from '../ui/detail-drawer';
import { ErrorAlert } from '../ui/error-alert';
import { FieldControl, FormField } from '../ui/form-field';
import { Action } from '../ui/load';
import { Modal } from '../ui/modal';
import { PageDetail } from '../ui/page-detail';
import { ErrorState, Skeleton } from '../ui/states';
import { ToastService } from '../ui/toasts';
import {
  CASE_CATEGORY,
  CASE_EVENT,
  CASE_OUTCOME,
  CASE_STATUS,
  caseTone,
  type DisciplinaryCase,
  needsDefence,
} from './training-model';

/** Processo disciplinar: factos, cronologia (só de acréscimo), documentos, instrução e decisão. */
@Component({
  selector: 'app-discipline-case',
  imports: [
    FormsModule,
    RouterLink,
    PageDetail,
    FieldList,
    Attachments,
    Modal,
    FormField,
    FieldControl,
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
      @let x = c()!;
      <app-page-detail
        [title]="'Processo ' + x.code"
        [subtitle]="x.employee.fullName + ' · ' + x.summary"
      >
        <ng-container actions>
          <a class="btn-secondary" [routerLink]="['/rh/colaboradores', x.employee.id]"
            >Ver colaborador</a
          >
          @if (x.access?.manage) {
            <button type="button" class="btn-secondary" data-testid="dc-add" (click)="openEvent()">
              Registar
            </button>
            @if (x.status === 'OPEN') {
              <button
                type="button"
                class="btn-secondary"
                data-testid="dc-review"
                (click)="review()"
              >
                Passar a instrução
              </button>
            }
            <button type="button" class="btn-primary" data-testid="dc-close" (click)="openClose()">
              Decidir e encerrar
            </button>
          }
        </ng-container>
        <p class="mb-4 rounded-card bg-warning-soft p-3 text-sm text-warning-text" role="note">
          Informação confidencial: cada consulta fica registada.
        </p>
        <section class="card" aria-labelledby="dc-facts">
          <h2 id="dc-facts" class="mb-2 flex items-center gap-2 font-semibold">
            Factos
            <span class="badge" [class]="tone(x.status)" data-testid="dc-status">{{
              status(x.status)
            }}</span>
          </h2>
          <p class="text-sm whitespace-pre-line">{{ x.description }}</p>
        </section>
        <section class="card mt-4" aria-labelledby="dc-timeline">
          <h2 id="dc-timeline" class="mb-3 font-semibold">Cronologia</h2>
          <ol class="space-y-3 border-l border-border pl-4 text-sm" data-testid="dc-events">
            @for (e of x.events; track e.id) {
              <li>
                <p class="font-medium">{{ kind(e.kind) }} · {{ date(e.occurredOn) }}</p>
                <p class="whitespace-pre-line">{{ e.text }}</p>
                <p class="text-xs text-muted">{{ e.createdBy }}</p>
              </li>
            }
          </ol>
        </section>
        <section class="card mt-4" aria-labelledby="dc-docs">
          <h2 id="dc-docs" class="mb-3 font-semibold">Documentos</h2>
          <app-attachments
            subjectType="disciplinary_case"
            [subjectId]="x.id"
            [canWrite]="!!x.access?.manage"
          />
        </section>
        <div aside>
          <section class="card" aria-labelledby="dc-summary">
            <h2 id="dc-summary" class="mb-3 font-semibold">Resumo</h2>
            <app-field-list
              [fields]="[
                { label: 'Colaborador', value: x.employee.code + ' — ' + x.employee.fullName },
                { label: 'Data dos factos', value: date(x.occurredOn) },
                { label: 'Categoria', value: category(x.category) },
                { label: 'Aberto por', value: x.createdBy },
                { label: 'Decisão', value: x.outcome ? outcome(x.outcome) : null },
                {
                  label: 'Decidido em',
                  value: x.decidedOn
                    ? date(x.decidedOn) + (x.decidedBy ? ' · ' + x.decidedBy : '')
                    : null,
                },
                { label: 'Fundamentação', value: x.outcomeDetails },
              ]"
            />
          </section>
        </div>
      </app-page-detail>
    }

    <app-modal title="Registar no processo" [open]="adding()" (closed)="adding.set(false)">
      <app-error-alert [error]="action.error()" [showDetails]="false" />
      <div class="space-y-3">
        <app-field label="Tipo" [required]="true" [error]="action.field('kind')">
          <select
            appControl
            class="input"
            data-testid="dc-kind"
            [(ngModel)]="ev.kind"
            [ngModelOptions]="{ standalone: true }"
          >
            <option value="NOTE">Nota</option>
            <option value="NOTIFICATION">Notificação ao trabalhador</option>
            <option value="HEARING">Audiência</option>
            <option value="DEFENCE">Defesa do trabalhador</option>
          </select>
        </app-field>
        <app-field label="Data" [required]="true" [error]="action.field('occurredOn')">
          <input
            appControl
            class="input"
            type="date"
            data-testid="dc-date"
            [(ngModel)]="ev.occurredOn"
            [ngModelOptions]="{ standalone: true }"
          />
        </app-field>
        <app-field label="Texto" [required]="true" [error]="action.field('text')">
          <textarea
            appControl
            class="input min-h-24"
            data-testid="dc-text"
            [(ngModel)]="ev.text"
            [ngModelOptions]="{ standalone: true }"
          ></textarea>
        </app-field>
      </div>
      <ng-container actions>
        <button type="button" class="btn-secondary" (click)="adding.set(false)">Cancelar</button>
        <button
          type="button"
          class="btn-primary"
          data-testid="dc-add-confirm"
          [disabled]="action.busy()"
          (click)="saveEvent()"
        >
          Registar
        </button>
      </ng-container>
    </app-modal>

    <app-modal title="Decidir e encerrar" [open]="closing()" (closed)="closing.set(false)">
      <app-error-alert [error]="action.error()" [showDetails]="false" />
      <div class="space-y-3">
        <app-field label="Decisão" [required]="true" [error]="action.field('outcome')">
          <select
            appControl
            class="input"
            data-testid="dc-outcome"
            [(ngModel)]="dec.outcome"
            [ngModelOptions]="{ standalone: true }"
          >
            @for (o of outcomes; track o[0]) {
              <option [value]="o[0]">{{ o[1] }}</option>
            }
          </select>
        </app-field>
        @if (defenceMissing()) {
          <p class="text-sm text-warning-text" role="status">
            Uma sanção exige a defesa ou a audiência registada antes.
          </p>
        }
        <app-field label="Data da decisão" [required]="true" [error]="action.field('decidedOn')">
          <input
            appControl
            class="input"
            type="date"
            data-testid="dc-decided"
            [(ngModel)]="dec.decidedOn"
            [ngModelOptions]="{ standalone: true }"
          />
        </app-field>
        <app-field label="Fundamentação" [required]="true" [error]="action.field('outcomeDetails')">
          <textarea
            appControl
            class="input min-h-24"
            data-testid="dc-details"
            [(ngModel)]="dec.outcomeDetails"
            [ngModelOptions]="{ standalone: true }"
          ></textarea>
        </app-field>
      </div>
      <ng-container actions>
        <button type="button" class="btn-secondary" (click)="closing.set(false)">Voltar</button>
        <button
          type="button"
          class="btn-primary"
          data-testid="dc-close-confirm"
          [disabled]="action.busy()"
          (click)="close()"
        >
          Encerrar
        </button>
      </ng-container>
    </app-modal>
  `,
})
export class DisciplineCase {
  readonly id = input.required<string>();
  private readonly api = inject(Api);
  private readonly toasts = inject(ToastService);
  private readonly confirm = inject(ConfirmService);
  private readonly breadcrumbs = inject(Breadcrumbs);
  protected readonly c = signal<DisciplinaryCase | null>(null);
  protected readonly loadError = signal<ApiError | null>(null);
  protected readonly adding = signal(false);
  protected readonly closing = signal(false);
  protected readonly action = new Action();
  protected ev = { kind: 'NOTE', occurredOn: '', text: '' };
  protected dec = { outcome: 'NO_ACTION', decidedOn: '', outcomeDetails: '' };
  protected readonly outcomes = Object.entries(CASE_OUTCOME);
  protected readonly date = formatDate;
  protected readonly tone = caseTone;
  protected readonly status = (s: DisciplinaryCase['status']) => CASE_STATUS[s];
  protected readonly kind = (k: string) => CASE_EVENT[k] ?? k;
  protected readonly category = (k: string) => CASE_CATEGORY[k] ?? k;
  protected readonly outcome = (k: string) => CASE_OUTCOME[k] ?? k;
  protected readonly defenceMissing = () => needsDefence(this.dec.outcome, this.c()?.events ?? []);

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
      const x = await this.api.get<DisciplinaryCase>(`hr/discipline/cases/${id}`);
      this.c.set(x);
      this.breadcrumbs.setCurrent(`Processo ${x.code}`);
    } catch (error) {
      this.loadError.set(ApiError.from(error));
    }
  }

  protected openEvent() {
    this.action.error.set(null);
    this.ev = { kind: 'NOTE', occurredOn: new Date().toISOString().slice(0, 10), text: '' };
    this.adding.set(true);
  }

  protected async saveEvent() {
    const x = this.c()!;
    const done = await this.action.run(() =>
      this.api.post<DisciplinaryCase>(`hr/discipline/cases/${x.id}/events`, {
        ...this.ev,
        expectedVersion: x.version,
      }),
    );
    if (!done) return;
    this.adding.set(false);
    this.c.set(done);
    this.toasts.show('Registo acrescentado.');
  }

  protected async review() {
    const x = this.c()!;
    const done = await this.action.run(() =>
      this.api.post<DisciplinaryCase>(`hr/discipline/cases/${x.id}/review`, {
        expectedVersion: x.version,
      }),
    );
    if (!done) {
      this.toasts.show(this.action.error()?.message ?? 'Erro.', 'error');
      return;
    }
    this.c.set(done);
    this.toasts.show('Processo em instrução.');
  }

  protected openClose() {
    this.action.error.set(null);
    this.dec = {
      outcome: 'NO_ACTION',
      decidedOn: new Date().toISOString().slice(0, 10),
      outcomeDetails: '',
    };
    this.closing.set(true);
  }

  protected async close() {
    const x = this.c()!;
    const ok = await this.confirm.ask({
      title: 'Encerrar processo',
      message: 'Encerrado, o processo não muda. Confirma a decisão?',
      confirmLabel: 'Encerrar',
      danger: true,
    });
    if (!ok) return;
    const done = await this.action.run(() =>
      this.api.post<DisciplinaryCase>(`hr/discipline/cases/${x.id}/close`, {
        ...this.dec,
        expectedVersion: x.version,
      }),
    );
    if (!done) return;
    this.closing.set(false);
    this.c.set(done);
    this.toasts.show('Processo encerrado.');
  }
}
