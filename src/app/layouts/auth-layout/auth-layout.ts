import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { AppConfigService } from '../../core/config/app-config.service';
import { Card } from '../../shared/ui/card/card';
import { ThemeToggle } from '../components/theme-toggle/theme-toggle';

/** Moldura das páginas de autenticação e dos estados sem acesso. */
@Component({
  selector: 'app-auth-layout',
  imports: [RouterOutlet, Card, ThemeToggle],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="relative flex min-h-dvh flex-col items-center justify-center px-4 py-10">
      <div class="absolute end-4 top-4"><app-theme-toggle /></div>

      <div class="w-full max-w-md">
        <div class="mb-8 flex flex-col items-center gap-3">
          <span
            class="grid size-12 place-items-center rounded-xl bg-brand-600 text-xl font-bold text-white"
            aria-hidden="true"
          >
            S
          </span>
          <p class="text-lg font-semibold tracking-tight">{{ appName }}</p>
        </div>

        <app-card [flush]="true">
          <main class="p-6 sm:p-8"><router-outlet /></main>
        </app-card>
      </div>
    </div>
  `,
})
export class AuthLayout {
  protected readonly appName = inject(AppConfigService).appName;
}
