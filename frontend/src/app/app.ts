import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';

/** Moldura da aplicação: cabeçalho e área de conteúdo das rotas. */
@Component({
  selector: 'app-root',
  imports: [RouterOutlet],
  template: `
    <div class="min-h-screen bg-slate-50 text-slate-900">
      <header class="border-b border-slate-200 bg-white">
        <div class="mx-auto flex max-w-5xl items-center px-4 py-3">
          <span class="text-lg font-semibold">Aplicação</span>
        </div>
      </header>
      <main class="mx-auto max-w-5xl px-4 py-8">
        <router-outlet />
      </main>
    </div>
  `,
})
export class App {}
