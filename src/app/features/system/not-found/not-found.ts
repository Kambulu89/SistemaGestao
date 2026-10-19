import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';

@Component({
  selector: 'app-not-found',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    <section class="py-8 text-center">
      <p class="text-sm font-semibold text-brand-600 dark:text-brand-400">404</p>
      <h1 class="mt-2 text-2xl font-bold tracking-tight">Página não encontrada</h1>
      <p class="mt-2 text-fg-muted">O endereço que procura não existe ou foi movido.</p>
      <a
        routerLink="/"
        class="mt-6 inline-flex h-10 items-center rounded-lg bg-brand-600 px-4 text-sm font-medium text-white transition-colors hover:bg-brand-700"
      >
        Voltar ao início
      </a>
    </section>
  `,
})
export class NotFound {}
