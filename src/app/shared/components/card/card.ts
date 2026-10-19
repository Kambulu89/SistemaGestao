import { ChangeDetectionStrategy, Component, input } from '@angular/core';

@Component({
  selector: 'app-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block rounded-xl border border-line bg-surface p-5 shadow-sm' },
  template: `
    @if (title(); as title) {
      <h2 class="mb-3 text-sm font-semibold text-fg">{{ title }}</h2>
    }
    <ng-content />
  `,
})
export class Card {
  readonly title = input<string>();
}
