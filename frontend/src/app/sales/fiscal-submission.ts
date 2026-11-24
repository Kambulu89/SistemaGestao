import { Component, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { Api, ApiError } from '../core/api';
import { Breadcrumbs } from '../core/breadcrumbs';
import { formatDateTime } from '../ui/dates';
import { ErrorAlert } from '../ui/error-alert';
import { FieldControl, FormField } from '../ui/form-field';
import { Action } from '../ui/load';
import { Modal } from '../ui/modal';
import { EntityFormPage } from '../ui/templates';
import { ToastService } from '../ui/toasts';
import {
  ATTEMPT_ACTION,
  DOC_TYPE,
  documentLink,
  INTEGRATION_NOTICE,
  type Submission,
  SUBMISSION_STATUS,
  submissionTone,
} from './fiscal-integration-model';

/** Submissão fiscal de um documento (simulação): estado, pedido, resposta, payload fotografado e tentativas. */
@Component({
  selector: 'app-fiscal-submission',
  imports: [FormsModule, RouterLink, EntityFormPage, FormField, FieldControl, Modal, ErrorAlert],
  template: `
    <app-entity-form-page
      [title]="x() ? 'Comunicação de ' + x()!.documentNumber : 'Comunicação fiscal'"
      [subtitle]="x() ? x()!.providerLabel : ''"
      formId="fiscal-submission"
      [loading]="!x()"
      [loadError]="loadError()"
      [readOnly]="true"
      (cancelled)="back()"
      (retry)="load()"
    >
      @if (x(); as s) {
        <p
          class="rounded-card border border-warning bg-warning-soft p-3 text-sm text-warning-text"
          role="note"
          data-testid="fsub-simulation"
        >
          {{ notice }}
        </p>
        <section class="card space-y-3" aria-label="Estado">
          <div class="flex flex-wrap items-center gap-2">
            <span class="badge" [class]="tone(s.status)" data-testid="fsub-status">{{
              status(s.status)
            }}</span>
            @if (s.inContingency) {
              <span class="badge bg-warning-soft text-warning-text">Emitido em contingência</span>
            }
          </div>
          <dl class="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
            <div>
              <dt class="text-muted">Documento</dt>
              <dd>
                <a class="link" data-testid="fsub-document" [routerLink]="link(s)">{{
                  s.documentNumber
                }}</a>
                · {{ docType(s.documentType) }} · {{ s.legalEntity.code }}
              </dd>
            </div>
            <div>
              <dt class="text-muted">Ambiente e formato</dt>
              <dd>{{ s.environment }} · {{ s.payloadFormat }} (interno, não oficial)</dd>
            </div>
            <div>
              <dt class="text-muted">Tentativas</dt>
              <dd>
                {{ s.attempts }}{{ s.failures ? ' · ' + s.failures + ' falha(s) seguida(s)' : '' }}
                {{ s.nextAttemptAt ? ' · próxima ' + when(s.nextAttemptAt) : '' }}
              </dd>
            </div>
            <div>
              <dt class="text-muted">Pedido</dt>
              <dd class="break-all" data-testid="fsub-request">{{ s.requestId ?? '—' }}</dd>
            </div>
            <div>
              <dt class="text-muted">Resposta</dt>
              <dd data-testid="fsub-result">
                {{ s.resultCode ?? '—' }}{{ s.resultMessage ? ' · ' + s.resultMessage : '' }}
              </dd>
            </div>
            <div>
              <dt class="text-muted">Chave de idempotência</dt>
              <dd class="text-xs break-all">{{ s.idempotencyKey }}</dd>
            </div>
          </dl>
          @if (s.validationIssues.length) {
            <ul class="list-disc pl-5 text-sm text-danger-text" data-testid="fsub-issues">
              @for (i of s.validationIssues; track $index) {
                <li>{{ i.message }}</li>
              }
            </ul>
          }
          @if (dialog() === null && act.error(); as err) {
            <app-error-alert [error]="err" [showDetails]="false" />
          }
          <div class="flex flex-wrap gap-2">
            @if (s.can.process) {
              <button
                type="button"
                class="btn-primary"
                data-testid="fsub-process"
                [disabled]="act.busy()"
                (click)="process()"
              >
                Processar agora
              </button>
            }
            @if (s.can.requeue) {
              <button
                type="button"
                class="btn-secondary"
                data-testid="fsub-requeue"
                (click)="openRequeue()"
              >
                Repetir
              </button>
            }
          </div>
        </section>

        <section class="card" aria-labelledby="fsub-h-title">
          <h2 id="fsub-h-title" class="mb-2 font-semibold">Tentativas e respostas</h2>
          <ul class="space-y-1 text-sm" data-testid="fsub-history">
            @for (h of s.history; track $index) {
              <li>
                <span class="text-muted">{{ when(h.at) }}</span> · {{ action(h.action) }} ·
                {{ h.outcome }}{{ h.code ? ' · ' + h.code : ''
                }}{{ h.message ? ' · ' + h.message : ''
                }}{{ h.durationMs !== null ? ' · ' + h.durationMs + ' ms' : '' }}
              </li>
            } @empty {
              <li class="text-muted">Ainda sem tentativas.</li>
            }
          </ul>
        </section>

        <section class="card" aria-labelledby="fsub-p-title">
          <h2 id="fsub-p-title" class="mb-2 font-semibold">Payload fotografado na emissão</h2>
          <p class="mb-2 text-xs break-all text-muted">Impressão digital: {{ s.payloadHash }}</p>
          <pre
            class="max-h-96 overflow-auto rounded-card bg-surface-2 p-3 text-xs"
            data-testid="fsub-payload"
            >{{ json(s.payload) }}</pre>
        </section>
      }
    </app-entity-form-page>

    <app-modal title="Repetir a comunicação" [open]="dialog() !== null" (closed)="dialog.set(null)">
      <app-error-alert [error]="act.error()" [showDetails]="false" />
      <p class="mb-3 text-sm">As tentativas recomeçam; o payload e a chave são os mesmos.</p>
      <app-field label="Motivo" [required]="true" [error]="act.field('reason')">
        <textarea
          appControl
          class="input min-h-16"
          name="reason"
          data-testid="fsub-reason"
          [(ngModel)]="reason"
        ></textarea>
      </app-field>
      <div class="mt-4 flex justify-end gap-2">
        <button type="button" class="btn-secondary" (click)="dialog.set(null)">Cancelar</button>
        <button
          type="button"
          class="btn-primary"
          data-testid="fsub-ok"
          [disabled]="act.busy()"
          (click)="requeue()"
        >
          Confirmar
        </button>
      </div>
    </app-modal>
  `,
})
export class FiscalSubmissionPage {
  readonly id = input<string | null>(null);
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  private readonly toasts = inject(ToastService);
  private readonly breadcrumbs = inject(Breadcrumbs);
  protected readonly x = signal<Submission | null>(null);
  protected readonly loadError = signal<ApiError | null>(null);
  protected readonly dialog = signal<'requeue' | null>(null);
  protected readonly act = new Action();
  protected readonly notice = INTEGRATION_NOTICE;
  protected readonly when = formatDateTime;
  protected readonly tone = submissionTone;
  protected readonly link = documentLink;
  protected readonly status = (s: string) => SUBMISSION_STATUS[s] ?? s;
  protected readonly docType = (s: string) => DOC_TYPE[s] ?? s;
  protected readonly action = (s: string) => ATTEMPT_ACTION[s] ?? s;
  protected readonly json = (v: unknown) => JSON.stringify(v, null, 2);
  protected reason = '';

  constructor() {
    effect(() => {
      this.id();
      untracked(() => void this.load());
    });
  }

  protected async load() {
    this.loadError.set(null);
    try {
      this.set(await this.api.get<Submission>(`sales/fiscal/submissions/${this.id()}`));
    } catch (e) {
      this.loadError.set(ApiError.from(e));
    }
  }
  private set(s: Submission) {
    this.x.set(s);
    this.breadcrumbs.setCurrent(s.documentNumber);
  }
  protected back() {
    void this.router.navigate(['/vendas/fiscal/integracao']);
  }
  protected async process() {
    const r = await this.act.run(() =>
      this.api.post<Submission>(`sales/fiscal/submissions/${this.x()!.id}/process`, {}),
    );
    if (!r) return;
    this.set(r);
    this.toasts.show(`Processado: ${SUBMISSION_STATUS[r.status] ?? r.status}.`);
  }
  protected openRequeue() {
    this.act.error.set(null);
    this.reason = '';
    this.dialog.set('requeue');
  }
  protected async requeue() {
    const s = this.x()!;
    const r = await this.act.run(() =>
      this.api.post<Submission>(`sales/fiscal/submissions/${s.id}/requeue`, {
        expectedVersion: s.version,
        reason: this.reason,
      }),
    );
    if (!r) return;
    this.set(r);
    this.dialog.set(null);
    this.toasts.show('De volta à fila.');
  }
}
