import { ChangeDetectionStrategy, Component, inject, signal, VERSION } from '@angular/core';
import { APP_ENVIRONMENT } from '../../core/config/app-environment';
import { ThemeService } from '../../core/services/theme';
import { Button } from '../../shared/components/button/button';
import { Card } from '../../shared/components/card/card';

/** Página inicial que valida a configuração base (stack, ambiente, tema e Signals). */
@Component({
  selector: 'app-home',
  imports: [Card, Button],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './home.html',
})
export class Home {
  private readonly theme = inject(ThemeService);

  protected readonly angularVersion = VERSION.full;
  protected readonly environment = inject(APP_ENVIRONMENT);
  protected readonly themeResolved = this.theme.resolved;
  protected readonly clicks = signal(0);

  protected increment(): void {
    this.clicks.update((n) => n + 1);
  }
}
