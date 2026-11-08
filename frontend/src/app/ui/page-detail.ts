import { Component, input } from '@angular/core';
import { StatusBadge } from './status-badge';

/**
 * Página de detalhe: cabeçalho (título, subtítulo, estado, acções), conteúdo principal e coluna lateral opcional
 * (`<div aside>`), que passa para baixo em ecrãs pequenos.
 */
@Component({
  selector: 'app-page-detail',
  imports: [StatusBadge],
  template: `
    <div class="mb-5 flex flex-wrap items-start justify-between gap-3">
      <div class="min-w-0">
        <h1 class="flex flex-wrap items-center gap-2 text-2xl font-semibold">
          <span class="truncate">{{ title() }}</span>
          @if (status()) {
            <app-status-badge [status]="status()" />
          }
        </h1>
        @if (subtitle()) {
          <p class="mt-1 text-sm text-muted">{{ subtitle() }}</p>
        }
      </div>
      <div class="flex flex-wrap gap-2"><ng-content select="[actions]" /></div>
    </div>
    <div class="grid grid-cols-1 gap-4 lg:grid-cols-3">
      <div class="space-y-4 lg:col-span-2"><ng-content /></div>
      <div class="space-y-4"><ng-content select="[aside]" /></div>
    </div>
  `,
})
export class PageDetail {
  readonly title = input.required<string>();
  readonly subtitle = input<string | null>(null);
  readonly status = input<string | null>(null);
}
