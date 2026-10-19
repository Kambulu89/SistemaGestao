import { ChangeDetectionStrategy, Component, input } from '@angular/core';

@Component({
  selector: 'app-page-header',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'mb-6 flex flex-wrap items-start justify-between gap-4' },
  template: `
    <div class="min-w-0">
      <h1 class="text-2xl font-bold tracking-tight">{{ title() }}</h1>
      @if (description(); as description) {
        <p class="mt-1 max-w-2xl text-fg-muted">{{ description }}</p>
      }
    </div>
    <div class="flex items-center gap-2"><ng-content select="[pageActions]" /></div>
  `,
})
export class PageHeader {
  readonly title = input.required<string>();
  readonly description = input<string>();
}
