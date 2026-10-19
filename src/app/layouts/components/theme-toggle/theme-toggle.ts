import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { type ThemePreference, ThemeService } from '../../../core/config/theme.service';
import { Button } from '../../../shared/ui/button/button';
import { Icon } from '../../../shared/ui/icon/icon';

const THEME_UI: Record<ThemePreference, { icon: string; label: string }> = {
  light: { icon: 'sun', label: 'claro' },
  dark: { icon: 'moon', label: 'escuro' },
  system: { icon: 'desktop', label: 'do sistema' },
};

@Component({
  selector: 'app-theme-toggle',
  imports: [Button, Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    <app-button
      variant="ghost"
      [label]="'Tema ' + ui().label + '. Clique para alterar.'"
      (click)="theme.cycle()"
    >
      <app-icon [name]="ui().icon" />
    </app-button>
  `,
})
export class ThemeToggle {
  protected readonly theme = inject(ThemeService);
  protected readonly ui = computed(() => THEME_UI[this.theme.preference()]);
}
