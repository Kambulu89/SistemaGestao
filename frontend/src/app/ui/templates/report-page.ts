import { Component, input, output } from '@angular/core';
import type { ApiError } from '../../core/api';
import { formatDateTime } from '../dates';
import { ErrorAlert } from '../error-alert';
import { Icon } from '../icon';
import { EmptyState } from '../states';

/**
 * ReportPage: parâmetros (projectados em `[params]`), botão Gerar (sem pedidos repetidos), erro do servidor, estado
 * vazio antes de gerar, barra com exportação e impressão, e o resultado (conteúdo projectado) com a data de geração e o
 * resumo dos parâmetros também na impressão. O cálculo é sempre do servidor.
 */
@Component({
  selector: 'app-report-page',
  imports: [ErrorAlert, Icon, EmptyState],
  template: `
    <div class="mb-5">
      <h1 class="text-2xl font-semibold">{{ title() }}</h1>
      @if (subtitle()) {
        <p class="mt-1 text-sm text-muted">{{ subtitle() }}</p>
      }
    </div>
    <form
      class="no-print card mb-4 flex flex-wrap items-end gap-3"
      [attr.aria-label]="'Parâmetros: ' + title()"
      (submit)="onSubmit($event)"
    >
      <ng-content select="[params]" />
      <button type="submit" class="btn-primary" [disabled]="busy() || !canRun()">
        {{ busy() ? 'A gerar…' : 'Gerar' }}
      </button>
    </form>
    <app-error-alert [error]="error()" />
    @if (hasResult()) {
      <div class="mb-2 flex flex-wrap items-center justify-between gap-2">
        <p class="text-xs text-muted" data-testid="report-meta">
          {{ summary() }}{{ summary() ? ' · ' : '' }}gerado em {{ when(generatedAt()) }}
        </p>
        <div class="no-print flex gap-2">
          @if (exportable()) {
            <button type="button" class="btn-secondary" (click)="exported.emit()">
              <app-icon name="download" [size]="16" /> {{ exportLabel() }}
            </button>
          }
          <button type="button" class="btn-secondary" (click)="print()">Imprimir / PDF</button>
        </div>
      </div>
      <ng-content />
    } @else if (!busy()) {
      <app-empty-state
        icon="file"
        title="Ainda sem resultados"
        description="Escolha os parâmetros e carregue em Gerar."
      />
    }
  `,
})
export class ReportPage {
  readonly title = input.required<string>();
  readonly subtitle = input<string | null>(null);
  readonly busy = input(false);
  readonly error = input<ApiError | null>(null);
  readonly canRun = input(true);
  readonly hasResult = input(false);
  readonly exportable = input(true);
  readonly exportLabel = input('Exportar CSV');
  /** Resumo legível dos parâmetros usados (vai também para a impressão). */
  readonly summary = input<string | null>(null);
  readonly generatedAt = input<string>(new Date().toISOString());
  readonly run = output();
  readonly exported = output();
  protected readonly when = formatDateTime;

  protected onSubmit(event: Event) {
    event.preventDefault();
    if (!this.busy() && this.canRun()) this.run.emit();
  }

  protected print() {
    window.print();
  }
}
