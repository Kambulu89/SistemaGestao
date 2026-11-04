import { Component, inject } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { HealthService } from '../core/health.service';

/** Página inicial: confirma que o frontend fala com a API e que a base de dados responde. */
@Component({
  selector: 'app-home',
  template: `
    <h1 class="text-2xl font-semibold">Bem-vindo</h1>
    <p class="mt-2 text-slate-600">Estrutura base: Angular, Tailwind CSS e AdonisJS.</p>

    <section class="mt-6 rounded-lg border border-slate-200 bg-white p-4" data-testid="api-status">
      <h2 class="text-sm font-medium text-slate-500">Estado da API</h2>
      @if (health.isLoading()) {
        <p class="mt-1">A verificar…</p>
      } @else if (health.error()) {
        <p class="mt-1 font-medium text-red-700">Indisponível</p>
      } @else if (health.value(); as value) {
        <p class="mt-1 font-medium" [class.text-green-700]="value.status === 'ok'">
          {{ value.status === 'ok' ? 'Disponível' : 'Degradada' }} · base de dados
          {{ value.database === 'up' ? 'ligada' : 'em baixo' }}
        </p>
      }
    </section>
  `,
})
export class Home {
  private readonly service = inject(HealthService);
  protected readonly health = rxResource({ stream: () => this.service.check() });
}
