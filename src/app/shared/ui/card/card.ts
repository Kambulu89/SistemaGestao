import { ChangeDetectionStrategy, Component, input } from '@angular/core';

@Component({
  selector: 'app-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'block rounded-xl border border-line bg-surface shadow-sm',
    '[class.p-5]': '!flush()',
    '[class.overflow-hidden]': 'flush()',
  },
  template: `
    @if (title(); as title) {
      <h2 class="mb-3 text-sm font-semibold text-fg" [class.px-5]="flush()" [class.pt-5]="flush()">
        {{ title }}
      </h2>
    }
    <ng-content />
  `,
})
export class Card {
  readonly title = input<string>();
  /** Sem padding interno (ex.: para tabelas que ocupam toda a largura do cartão). */
  readonly flush = input(false);
}
