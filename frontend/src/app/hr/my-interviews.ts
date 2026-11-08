import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Api, ApiError } from '../core/api';
import { formatDateTime } from '../ui/dates';
import { ErrorAlert } from '../ui/error-alert';
import { FieldControl, FormField } from '../ui/form-field';
import { Action } from '../ui/load';
import { Modal } from '../ui/modal';
import { PageHeader } from '../ui/page-header';
import { EmptyState, ErrorState, Skeleton } from '../ui/states';
import { ToastService } from '../ui/toasts';
import {
  INTERVIEW_MODE,
  INTERVIEW_STATUS,
  type Interview,
  RECOMMENDATION,
  tone,
} from './recruitment-model';

/**
 * As minhas entrevistas: o entrevistador vê só as entrevistas que lhe foram atribuídas (sem acesso ao resto do
 * recrutamento), marca-as como realizadas e regista a sua avaliação.
 */
@Component({
  selector: 'app-my-interviews',
  imports: [
    FormsModule,
    PageHeader,
    FormField,
    FieldControl,
    Modal,
    ErrorAlert,
    EmptyState,
    ErrorState,
    Skeleton,
  ],
  template: `
    <app-page-header
      title="As minhas entrevistas"
      subtitle="Entrevistas de recrutamento em que é entrevistador. Avalie depois de realizada."
    />
    @if (error()) {
      <app-error-state [error]="error()" (retry)="load()" />
    } @else if (items() === null) {
      <div class="card"><app-skeleton /></div>
    } @else if (!items()!.length) {
      <app-empty-state title="Sem entrevistas atribuídas" icon="calendar" />
    } @else {
      <ul class="space-y-3">
        @for (i of items()!; track i.id) {
          <li
            class="card flex flex-wrap items-center justify-between gap-3"
            data-testid="my-interview"
          >
            <div class="min-w-0">
              <p class="font-semibold">{{ i.candidateName }}</p>
              <p class="text-sm text-muted">
                {{ i.requisition?.code }} — {{ i.requisition?.title }} ·
                {{ dateTime(i.scheduledAt) }} · {{ mode(i.mode) }}
                {{ i.location ? '· ' + i.location : '' }}
              </p>
            </div>
            <div class="flex flex-wrap items-center gap-2">
              <span class="badge" [class]="tone(i.status)">{{ status(i.status) }}</span>
              @if (i.status === 'SCHEDULED') {
                <button
                  type="button"
                  class="btn-secondary"
                  data-testid="mark-done"
                  (click)="markDone(i)"
                >
                  Marcar realizada
                </button>
              }
              @if (i.status === 'DONE' && !i.evaluated) {
                <button
                  type="button"
                  class="btn-primary"
                  data-testid="my-evaluate"
                  (click)="openEvaluation(i)"
                >
                  Avaliar
                </button>
              }
              @if (i.evaluated) {
                <span class="text-sm text-muted">Avaliada</span>
              }
            </div>
          </li>
        }
      </ul>
    }

    <app-modal
      title="Avaliar entrevista"
      [open]="evaluating() !== null"
      (closed)="evaluating.set(null)"
    >
      <app-error-alert [error]="action.error()" [showDetails]="false" />
      <div class="space-y-3">
        <app-field label="Classificação (1 a 5)" [required]="true" [error]="action.field('score')">
          <select
            appControl
            class="input"
            data-testid="my-score"
            [(ngModel)]="score"
            [ngModelOptions]="{ standalone: true }"
          >
            @for (n of [1, 2, 3, 4, 5]; track n) {
              <option [ngValue]="n">{{ n }}</option>
            }
          </select>
        </app-field>
        <app-field label="Recomendação" [required]="true">
          <select
            appControl
            class="input"
            data-testid="my-rec"
            [(ngModel)]="recommendation"
            [ngModelOptions]="{ standalone: true }"
          >
            @for (r of recommendations; track r[0]) {
              <option [ngValue]="r[0]">{{ r[1] }}</option>
            }
          </select>
        </app-field>
        <app-field label="Comentários" [error]="action.field('comments')">
          <textarea
            appControl
            class="input min-h-24"
            [(ngModel)]="comments"
            [ngModelOptions]="{ standalone: true }"
          ></textarea>
        </app-field>
      </div>
      <ng-container actions>
        <button type="button" class="btn-secondary" (click)="evaluating.set(null)">Cancelar</button>
        <button
          type="button"
          class="btn-primary"
          data-testid="my-ev-confirm"
          [disabled]="action.busy()"
          (click)="evaluate()"
        >
          Registar
        </button>
      </ng-container>
    </app-modal>
  `,
})
export class MyInterviews {
  private readonly api = inject(Api);
  private readonly toasts = inject(ToastService);
  protected readonly items = signal<Interview[] | null>(null);
  protected readonly error = signal<ApiError | null>(null);
  protected readonly action = new Action();
  protected readonly evaluating = signal<Interview | null>(null);
  protected readonly tone = tone;
  protected readonly dateTime = formatDateTime;
  protected readonly mode = (m: Interview['mode']) => INTERVIEW_MODE[m];
  protected readonly status = (s: Interview['status']) => INTERVIEW_STATUS[s];
  protected readonly recommendations = Object.entries(RECOMMENDATION);
  protected score = 3;
  protected recommendation = 'HOLD';
  protected comments = '';

  constructor() {
    void this.load();
  }

  protected async load() {
    this.error.set(null);
    try {
      this.items.set(await this.api.get<Interview[]>('hr/interviews/mine'));
    } catch (error) {
      this.error.set(ApiError.from(error));
    }
  }

  protected async markDone(i: Interview) {
    const done = await this.action.run(() =>
      this.api.patch(`hr/interviews/${i.id}`, { status: 'DONE', expectedVersion: i.version }),
    );
    if (!done) return void this.toasts.show(this.action.error()?.message ?? 'Erro.', 'error');
    this.toasts.show('Entrevista marcada como realizada.');
    await this.load();
  }

  protected openEvaluation(i: Interview) {
    this.action.error.set(null);
    this.score = 3;
    this.recommendation = 'HOLD';
    this.comments = '';
    this.evaluating.set(i);
  }

  protected async evaluate() {
    const i = this.evaluating()!;
    const done = await this.action.run(() =>
      this.api.post(`hr/applications/${i.applicationId}/evaluations`, {
        interviewId: i.id,
        score: Number(this.score),
        recommendation: this.recommendation,
        comments: this.comments || null,
      }),
    );
    if (!done) return;
    this.evaluating.set(null);
    this.toasts.show('Avaliação registada.');
    await this.load();
  }
}
