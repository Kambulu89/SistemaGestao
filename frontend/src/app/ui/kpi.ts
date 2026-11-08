import { Component, computed, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Icon } from './icon';

export type KpiTone = 'neutral' | 'success' | 'warning' | 'danger';

/**
 * Indicador (KPIWidget / SummaryCard): rótulo, valor principal, detalhe e, opcionalmente, ligação para o ecrã de origem
 * e um tom de estado (barra lateral colorida e ícone; o texto mantém as cores de leitura). Valores `null` mostram "—"
 * com o motivo no detalhe: nunca se inventa um número.
 */
@Component({
  selector: 'app-kpi',
  imports: [RouterLink, Icon],
  template: `
    @if (link()) {
      <a
        [routerLink]="link()"
        class="card focus-ring relative block overflow-hidden hover:border-primary"
        [attr.data-testid]="testId()"
      >
        <span class="absolute inset-y-0 left-0 w-1" [class]="bar()" aria-hidden="true"></span>
        <p class="flex items-center gap-2 text-sm text-muted">
          @if (icon()) {
            <app-icon [name]="icon()!" [size]="16" />
          }
          {{ label() }}
        </p>
        <p class="mt-1 text-3xl font-semibold tabular-nums">{{ display() }}</p>
        @if (detail()) {
          <p class="text-xs text-muted">{{ detail() }}</p>
        }
      </a>
    } @else {
      <div class="card relative overflow-hidden" [attr.data-testid]="testId()">
        <span class="absolute inset-y-0 left-0 w-1" [class]="bar()" aria-hidden="true"></span>
        <p class="flex items-center gap-2 text-sm text-muted">
          @if (icon()) {
            <app-icon [name]="icon()!" [size]="16" />
          }
          {{ label() }}
        </p>
        <div class="mt-1 text-3xl font-semibold tabular-nums">{{ display() }}<ng-content /></div>
        @if (detail()) {
          <p class="text-xs text-muted">{{ detail() }}</p>
        }
      </div>
    }
  `,
})
export class Kpi {
  readonly label = input.required<string>();
  readonly value = input<string | number | null>(null);
  readonly detail = input<string | null>(null);
  readonly link = input<string | null>(null);
  readonly icon = input<string | null>(null);
  readonly tone = input<KpiTone>('neutral');
  readonly testId = input<string | null>(null);
  protected readonly display = computed(() => {
    const v = this.value();
    return v === null || v === undefined ? '—' : String(v);
  });
  protected readonly bar = computed(
    () =>
      ({
        neutral: 'bg-primary',
        success: 'bg-success',
        warning: 'bg-warning',
        danger: 'bg-danger',
      })[this.tone()],
  );
}
