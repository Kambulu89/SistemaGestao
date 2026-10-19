import { ChangeDetectionStrategy, Component, inject, input, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router } from '@angular/router';
import { filter } from 'rxjs';
import { Button } from '../button/button';
import { Icon } from '../icon/icon';

/**
 * Estrutura comum das áreas autenticadas: sidebar (drawer em ecrãs pequenos),
 * header e conteúdo. Os layouts compõem-na através de slots de projecção:
 * `[shellBrand]`, `[shellNav]`, `[shellHeader]` e o conteúdo principal.
 */
@Component({
  selector: 'app-shell',
  imports: [Button, Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(document:keydown.escape)': 'close()' },
  template: `
    <a
      href="#conteudo"
      class="sr-only focus:not-sr-only focus:fixed focus:start-4 focus:top-4 focus:z-[60] focus:rounded-lg focus:bg-brand-600 focus:px-4 focus:py-2 focus:text-white"
    >
      Saltar para o conteúdo
    </a>

    <div class="flex min-h-dvh">
      <aside
        id="sidebar"
        class="fixed inset-y-0 start-0 z-50 flex w-64 flex-col border-e transition-transform duration-200 lg:visible lg:sticky lg:top-0 lg:z-auto lg:h-dvh lg:translate-x-0"
        [class]="
          tone() === 'inverse'
            ? 'border-slate-800 bg-slate-900 text-slate-100'
            : 'border-line bg-surface'
        "
        [class.-translate-x-full]="!open()"
        [class.invisible]="!open()"
      >
        <div class="flex h-16 shrink-0 items-center justify-between gap-2 px-4">
          <ng-content select="[shellBrand]" />
          <app-button
            class="lg:hidden"
            variant="ghost"
            label="Fechar menu de navegação"
            (click)="close()"
          >
            <app-icon name="close" />
          </app-button>
        </div>
        <div class="flex-1 overflow-y-auto">
          <ng-content select="[shellNav]" />
        </div>
      </aside>

      @if (open()) {
        <div
          class="fixed inset-0 z-40 bg-slate-900/50 lg:hidden"
          aria-hidden="true"
          (click)="close()"
        ></div>
      }

      <div class="flex min-w-0 flex-1 flex-col">
        <header
          class="sticky top-0 z-30 flex h-16 items-center gap-3 border-b border-line bg-surface px-4 sm:px-6"
        >
          <app-button
            class="lg:hidden"
            variant="ghost"
            label="Abrir menu de navegação"
            [attr.aria-expanded]="open()"
            aria-controls="sidebar"
            (click)="open.set(true)"
          >
            <app-icon name="menu" />
          </app-button>
          <div class="flex min-w-0 flex-1 items-center gap-3">
            <ng-content select="[shellHeader]" />
          </div>
        </header>

        <main id="conteudo" tabindex="-1" class="flex-1 p-4 sm:p-6 lg:p-8">
          <ng-content />
        </main>
      </div>
    </div>
  `,
})
export class Shell {
  readonly tone = input<'default' | 'inverse'>('default');
  protected readonly open = signal(false);

  constructor() {
    // Navegar (ex.: clicar num link do menu) fecha o drawer em ecrãs pequenos.
    inject(Router)
      .events.pipe(
        filter((e) => e instanceof NavigationEnd),
        takeUntilDestroyed(),
      )
      .subscribe(() => this.close());
  }

  protected close(): void {
    this.open.set(false);
  }
}
