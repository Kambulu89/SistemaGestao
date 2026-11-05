import { Component, input } from '@angular/core';

/** Moldura das páginas sem sessão. */
@Component({
  selector: 'app-auth-layout',
  template: `
    <main class="flex min-h-screen items-center justify-center bg-slate-100 px-4 py-10">
      <div class="w-full max-w-md">
        <p class="mb-4 text-center text-sm font-semibold tracking-wide text-indigo-700 uppercase">
          Sistema de Gestão
        </p>
        <section class="card p-6">
          <h1 class="mb-4 text-xl font-semibold text-slate-900">{{ title() }}</h1>
          <ng-content />
        </section>
      </div>
    </main>
  `,
})
export class AuthLayout {
  readonly title = input.required<string>();
}
