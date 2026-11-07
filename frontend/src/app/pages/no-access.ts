import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';

@Component({
  selector: 'app-no-access',
  imports: [RouterLink],
  template: `
    <section class="card max-w-lg">
      <h1 class="text-xl font-semibold">Sem acesso</h1>
      <p class="mt-2 text-sm text-muted">
        Não tem permissão para esta área, ou a funcionalidade não está incluída na subscrição da
        empresa.
      </p>
      <a routerLink="/" class="btn-link mt-3 inline-block">Voltar ao início</a>
    </section>
  `,
})
export class NoAccess {}
