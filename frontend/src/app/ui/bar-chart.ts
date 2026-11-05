import { Component, computed, input } from '@angular/core';

export interface Bar {
  label: string;
  value: number;
}

/**
 * Gráfico de barras em HTML/CSS (sem bibliotecas): o texto mantém o tamanho em qualquer largura e as cores vêm dos
 * tokens (funciona nos dois temas). Acessível: descrição completa no `aria-label` e tabela equivalente para leitores
 * de ecrã.
 */
@Component({
  selector: 'app-bar-chart',
  template: `
    <figure class="mt-3">
      <figcaption class="mb-2 text-xs font-medium text-muted">{{ title() }}</figcaption>
      <div class="flex h-36 items-end gap-2" role="img" [attr.aria-label]="description()">
        @for (b of bars(); track b.label) {
          <div
            class="flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1"
            aria-hidden="true"
          >
            <span class="text-xs tabular-nums text-fg">{{ b.value }}</span>
            <div
              class="w-full max-w-12 rounded-t bg-primary"
              [style.height.%]="percent(b.value)"
              [style.min-height.px]="b.value > 0 ? 2 : 0"
            ></div>
            <span class="w-full truncate text-center text-[11px] text-muted" [title]="b.label">{{
              b.label
            }}</span>
          </div>
        }
      </div>
      <table class="sr-only">
        <caption>
          {{
            title()
          }}
        </caption>
        <tbody>
          @for (b of bars(); track b.label) {
            <tr>
              <th scope="row">{{ b.label }}</th>
              <td>{{ b.value }}</td>
            </tr>
          }
        </tbody>
      </table>
    </figure>
  `,
})
export class BarChart {
  readonly title = input.required<string>();
  readonly bars = input.required<Bar[]>();
  private readonly max = computed(() => Math.max(1, ...this.bars().map((b) => b.value)));
  protected readonly description = computed(
    () =>
      `${this.title()}: ${this.bars()
        .map((b) => `${b.label} ${b.value}`)
        .join(', ')}`,
  );

  /** Altura da barra em % da área (reserva espaço para o valor e a etiqueta). */
  protected percent(value: number) {
    return Math.round((value / this.max()) * 70);
  }
}
