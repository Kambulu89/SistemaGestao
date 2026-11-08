import { Component, input } from '@angular/core';
import { PageHeader } from '../page-header';

export interface SettingsSection {
  id: string;
  label: string;
}

/**
 * SettingsPage: índice das secções à esquerda (ligações para âncoras, em ecrã pequeno passa para cima) e as secções
 * projectadas à direita, cada uma com `id` igual ao da entrada no índice.
 */
@Component({
  selector: 'app-settings-page',
  imports: [PageHeader],
  template: `
    <app-page-header [title]="title()" [subtitle]="subtitle()"
      ><ng-content select="[actions]"
    /></app-page-header>
    <div class="grid gap-6 lg:grid-cols-[14rem_minmax(0,1fr)]">
      <nav aria-label="Secções" class="lg:sticky lg:top-20 lg:self-start">
        <ul class="flex flex-wrap gap-1 lg:flex-col">
          @for (s of sections(); track s.id) {
            <li>
              <a
                [href]="'#' + s.id"
                class="focus-ring block rounded-control px-3 py-1.5 text-sm text-fg hover:bg-surface-2"
                (click)="go($event, s.id)"
                >{{ s.label }}</a
              >
            </li>
          }
        </ul>
      </nav>
      <div class="min-w-0 space-y-6"><ng-content /></div>
    </div>
  `,
})
export class SettingsPage {
  readonly title = input.required<string>();
  readonly subtitle = input<string | null>(null);
  readonly sections = input<SettingsSection[]>([]);

  /** Âncora dentro da página sem alterar a rota (o `base href` faria a ligação sair da página). */
  protected go(event: Event, id: string) {
    event.preventDefault();
    const el = document.getElementById(id);
    el?.scrollIntoView({ block: 'start' });
    el?.focus?.({ preventScroll: true });
  }
}
