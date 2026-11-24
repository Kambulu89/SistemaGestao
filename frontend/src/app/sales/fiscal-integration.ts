import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Api, ApiError } from '../core/api';
import { CellDef, type Column, DataTable } from '../ui/data-table';
import { formatDateTime } from '../ui/dates';
import { ErrorAlert } from '../ui/error-alert';
import { FilterBar, type FilterDef } from '../ui/filter-bar';
import { FieldControl, FormField } from '../ui/form-field';
import { ListState } from '../ui/list-state';
import { Action } from '../ui/load';
import { Modal } from '../ui/modal';
import { PageHeader } from '../ui/page-header';
import { ErrorState } from '../ui/states';
import { ToastService } from '../ui/toasts';
import {
  DOC_TYPE,
  INTEGRATION_NOTICE,
  type IntegrationEntity,
  type IntegrationSettings,
  SCENARIO,
  SUBMISSION_STATUS,
  type SubmissionRow,
  submissionTone,
} from './fiscal-integration-model';

/**
 * Integração fiscal electrónica (10.9), só em simulação: fornecedor e cenário do simulador por entidade, contingência
 * com motivo, fila de documentos emitidos com estado, tentativas e resposta; processar a fila.
 */
@Component({
  selector: 'app-fiscal-integration',
  imports: [
    FormsModule,
    PageHeader,
    ErrorState,
    ErrorAlert,
    FormField,
    FieldControl,
    Modal,
    FilterBar,
    DataTable,
    CellDef,
  ],
  template: `
    <app-page-header
      title="Integração fiscal electrónica"
      subtitle="Fila de comunicação dos documentos emitidos, por entidade."
    />
    <p
      class="mb-3 rounded-card border border-warning bg-warning-soft p-3 text-sm text-warning-text"
      role="note"
      data-testid="fi-simulation"
    >
      {{ notice }}
    </p>
    @if (loadError()) {
      <app-error-state [error]="loadError()" (retry)="load()" />
    } @else if (data(); as d) {
      @if (dialog() === null && act.error(); as err) {
        <app-error-alert class="mb-3 block" [error]="err" [showDetails]="true" />
      }
      <div class="mb-4 grid gap-4 lg:grid-cols-2">
        @for (e of d.entities; track e.legalEntity.id) {
          <section class="card space-y-3" [attr.data-testid]="'fi-entity-' + e.legalEntity.code">
            <div class="flex flex-wrap items-center gap-2">
              <h2 class="font-semibold">{{ e.legalEntity.code }} — {{ e.legalEntity.name }}</h2>
              @if (e.contingency) {
                <span class="badge bg-warning-soft text-warning-text" data-testid="fi-contingency"
                  >Contingência activa</span
                >
              }
            </div>
            @if (e.contingency) {
              <p class="text-sm">
                Desde {{ when(e.contingencySince) }} · <em>{{ e.contingencyReason }}</em
                >. Os documentos emitidos ficam retidos e são enviados quando terminar.
              </p>
            }
            <p class="text-sm text-muted" data-testid="fi-counts">
              @for (c of countsOf(e); track c[0]; let last = $last) {
                {{ status(c[0]) }}: {{ c[1] }}{{ last ? '' : ' · ' }}
              } @empty {
                Ainda sem documentos na fila.
              }
            </p>
            @if (forms[e.legalEntity.id]; as f) {
              <div class="grid gap-3 sm:grid-cols-3">
                <app-field label="Fornecedor" [error]="act.field('provider')">
                  <select
                    appControl
                    class="input"
                    [name]="'p' + e.legalEntity.id"
                    data-testid="fi-provider"
                    [disabled]="!e.canManage"
                    [(ngModel)]="f.provider"
                  >
                    @for (p of d.providers; track p.code) {
                      <option [value]="p.code" [disabled]="!p.available">
                        {{ p.label }}{{ p.available ? '' : ' (indisponível)' }}
                      </option>
                    }
                  </select>
                </app-field>
                <app-field label="Cenário do simulador">
                  <select
                    appControl
                    class="input"
                    [name]="'s' + e.legalEntity.id"
                    data-testid="fi-scenario"
                    [disabled]="!e.canManage"
                    [(ngModel)]="f.simulatorScenario"
                  >
                    @for (s of d.scenarios; track s) {
                      <option [value]="s">{{ scenario(s) }}</option>
                    }
                  </select>
                </app-field>
                <app-field label="Máximo de tentativas" [error]="act.field('maxAttempts')">
                  <input
                    appControl
                    class="input w-24"
                    type="number"
                    min="1"
                    max="20"
                    [name]="'m' + e.legalEntity.id"
                    [disabled]="!e.canManage"
                    [(ngModel)]="f.maxAttempts"
                  />
                </app-field>
              </div>
            }
            @if (unavailable(); as u) {
              <p class="text-xs text-muted">{{ u }}</p>
            }
            @if (e.canManage) {
              <div class="flex flex-wrap gap-2">
                <button
                  type="button"
                  class="btn-secondary"
                  data-testid="fi-save"
                  [disabled]="act.busy()"
                  (click)="save(e)"
                >
                  Guardar
                </button>
                <button
                  type="button"
                  class="btn-secondary"
                  data-testid="fi-toggle-contingency"
                  (click)="openContingency(e)"
                >
                  {{ e.contingency ? 'Terminar contingência' : 'Activar contingência' }}
                </button>
              </div>
            }
          </section>
        }
      </div>

      <section class="card space-y-3" aria-labelledby="fi-queue-title">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <h2 id="fi-queue-title" class="font-semibold">Fila de comunicação</h2>
          @if (canProcess()) {
            <button
              type="button"
              class="btn-primary"
              data-testid="fi-process"
              [disabled]="act.busy()"
              (click)="process()"
            >
              Processar a fila
            </button>
          }
        </div>
        <app-filter-bar
          id="fi"
          label="submissões"
          placeholder="Número do documento"
          [state]="list"
          [filters]="filters"
        />
        <app-data-table
          label="Submissões fiscais"
          tableId="fiscal-submissions"
          [columns]="columns"
          [rows]="list.page.value()?.items ?? []"
          [total]="list.page.value()?.total ?? 0"
          [loading]="list.page.loading()"
          [error]="list.page.error()"
          [offset]="list.offset()"
          [limit]="list.limit"
          emptyText="Nenhum documento na fila."
          (offsetChange)="list.goTo($event)"
          (retry)="list.reload()"
        >
          <ng-template appCell="status" let-row>
            <span class="badge" [class]="tone(row.status)" data-testid="fi-status">{{
              status(row.status)
            }}</span>
          </ng-template>
        </app-data-table>
      </section>
    }

    <app-modal
      [title]="target()?.contingency ? 'Terminar contingência' : 'Activar contingência'"
      [open]="dialog() !== null"
      (closed)="dialog.set(null)"
    >
      <app-error-alert [error]="act.error()" [showDetails]="false" />
      <p class="mb-3 text-sm">
        {{
          target()?.contingency
            ? 'Os documentos retidos voltam à fila e são enviados. O estado fiscal só muda com a resposta.'
            : 'Os documentos emitidos a partir de agora ficam retidos (estado fiscal "contingência") até a terminar.'
        }}
      </p>
      <app-field label="Motivo" [required]="true" [error]="act.field('reason')">
        <textarea
          appControl
          class="input min-h-16"
          name="reason"
          data-testid="fi-reason"
          [(ngModel)]="reason"
        ></textarea>
      </app-field>
      <div class="mt-4 flex justify-end gap-2">
        <button type="button" class="btn-secondary" (click)="dialog.set(null)">Cancelar</button>
        <button
          type="button"
          class="btn-primary"
          data-testid="fi-ok"
          [disabled]="act.busy()"
          (click)="toggleContingency()"
        >
          Confirmar
        </button>
      </div>
    </app-modal>
  `,
})
export class FiscalIntegrationPage {
  private readonly api = inject(Api);
  private readonly toasts = inject(ToastService);
  protected readonly data = signal<IntegrationSettings | null>(null);
  protected readonly loadError = signal<ApiError | null>(null);
  protected readonly dialog = signal<'contingency' | null>(null);
  protected readonly target = signal<IntegrationEntity | null>(null);
  protected readonly act = new Action();
  protected readonly notice = INTEGRATION_NOTICE;
  protected readonly when = formatDateTime;
  protected readonly tone = submissionTone;
  protected readonly status = (s: string) => SUBMISSION_STATUS[s] ?? s;
  protected readonly scenario = (s: string) => SCENARIO[s] ?? s;
  protected forms: Record<
    string,
    { provider: string; simulatorScenario: string; maxAttempts: number }
  > = {};
  protected reason = '';
  protected readonly filters: FilterDef[] = [
    {
      key: 'status',
      label: 'Estado',
      options: Object.entries(SUBMISSION_STATUS).map(([value, label]) => ({ value, label })),
    },
    {
      key: 'documentType',
      label: 'Documento',
      options: Object.entries(DOC_TYPE).map(([value, label]) => ({ value, label })),
    },
  ];
  protected readonly columns: Column<SubmissionRow>[] = [
    {
      key: 'document',
      label: 'Documento',
      required: true,
      link: (r) => ['/vendas/fiscal/submissoes', r.id],
      value: (r) => r.documentNumber,
    },
    { key: 'type', label: 'Tipo', hideOnMobile: true, value: (r) => DOC_TYPE[r.documentType] },
    { key: 'entity', label: 'Entidade', hideOnMobile: true, value: (r) => r.legalEntity },
    { key: 'attempts', label: 'Tentativas', align: 'end', hideOnMobile: true },
    {
      key: 'result',
      label: 'Resposta',
      hideOnMobile: true,
      value: (r) =>
        r.resultCode ? `${r.resultCode}${r.resultMessage ? ' · ' + r.resultMessage : ''}` : '—',
    },
    {
      key: 'next',
      label: 'Próxima tentativa',
      hiddenByDefault: true,
      value: (r) => (r.nextAttemptAt ? formatDateTime(r.nextAttemptAt) : '—'),
    },
    { key: 'status', label: 'Estado', value: (r) => SUBMISSION_STATUS[r.status] },
  ];
  protected readonly list = new ListState<SubmissionRow>(this.api, {
    url: 'sales/fiscal/submissions',
    filterKeys: ['status', 'documentType'],
    sortFields: [],
    limit: 25,
  });

  constructor() {
    void this.load();
  }

  protected canProcess() {
    return (this.data()?.entities ?? []).some((e) => e.canManage);
  }
  protected unavailable() {
    return (this.data()?.providers ?? [])
      .filter((p) => !p.available)
      .map((p) => `${p.label}: ${p.reason}`)
      .join(' ');
  }
  protected countsOf(e: IntegrationEntity) {
    return Object.entries(e.counts);
  }

  protected async load() {
    this.loadError.set(null);
    try {
      const d = await this.api.get<IntegrationSettings>('sales/fiscal/integration');
      this.forms = Object.fromEntries(
        d.entities.map((e) => [
          e.legalEntity.id,
          {
            provider: e.provider,
            simulatorScenario: e.simulatorScenario,
            maxAttempts: e.maxAttempts,
          },
        ]),
      );
      this.data.set(d);
    } catch (e) {
      this.loadError.set(ApiError.from(e));
    }
  }

  protected async save(e: IntegrationEntity) {
    const f = this.forms[e.legalEntity.id];
    const r = await this.act.run(() =>
      this.api.put<{ version: number }>(`sales/fiscal/integration/${e.legalEntity.id}`, {
        ...f,
        maxAttempts: Number(f.maxAttempts),
        expectedVersion: e.version,
      }),
    );
    if (!r) return;
    this.toasts.show('Integração guardada.');
    await this.load();
  }

  protected openContingency(e: IntegrationEntity) {
    this.act.error.set(null);
    this.reason = '';
    this.target.set(e);
    this.dialog.set('contingency');
  }

  protected async toggleContingency() {
    const e = this.target()!;
    const r = await this.act.run(() =>
      this.api.post<{ released?: number }>(
        `sales/fiscal/integration/${e.legalEntity.id}/contingency`,
        { active: !e.contingency, reason: this.reason, expectedVersion: e.version },
      ),
    );
    if (!r) return;
    this.dialog.set(null);
    this.toasts.show(
      e.contingency
        ? `Contingência terminada: ${r.released ?? 0} documento(s) de volta à fila.`
        : 'Contingência activada.',
    );
    await this.load();
    this.list.reload();
  }

  protected async process() {
    const r = await this.act.run(() =>
      this.api.post<{ processed: number }>('sales/fiscal/submissions/process', {}),
    );
    if (!r) return;
    this.toasts.show(`Fila processada: ${r.processed} chamada(s) ao simulador.`);
    await this.load();
    this.list.reload();
  }
}
