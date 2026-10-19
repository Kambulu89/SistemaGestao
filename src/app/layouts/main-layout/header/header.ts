import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';
import { ThemeService } from '../../../core/services/theme';
import type { IconName } from '../../../models/icon.model';
import type { ThemePreference } from '../../../models/theme.model';
import { Button } from '../../../shared/components/button/button';
import { Icon } from '../../../shared/components/icon/icon';

const THEME_UI: Record<ThemePreference, { icon: IconName; label: string }> = {
  light: { icon: 'sun', label: 'claro' },
  dark: { icon: 'moon', label: 'escuro' },
  system: { icon: 'desktop', label: 'do sistema' },
};

@Component({
  selector: 'app-header',
  imports: [Button, Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './header.html',
})
export class Header {
  private readonly theme = inject(ThemeService);

  readonly sidebarOpen = input(false);
  readonly menuToggle = output();

  protected readonly themeUi = computed(() => THEME_UI[this.theme.preference()]);

  protected cycleTheme(): void {
    this.theme.cycle();
  }
}
