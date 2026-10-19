import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { Icon } from '../icon/icon';

@Component({
  selector: 'app-empty-state',
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex flex-col items-center px-6 py-12 text-center' },
  template: `
    <span class="mb-3 rounded-full bg-surface-muted p-3 text-fg-muted">
      <app-icon [name]="icon()" class="size-6" />
    </span>
    <h2 class="text-base font-semibold">{{ title() }}</h2>
    @if (description(); as description) {
      <p class="mt-1 max-w-md text-sm text-fg-muted">{{ description }}</p>
    }
    <div class="mt-4 empty:hidden"><ng-content /></div>
  `,
})
export class EmptyState {
  readonly title = input.required<string>();
  readonly description = input<string>();
  readonly icon = input('cube');
}
