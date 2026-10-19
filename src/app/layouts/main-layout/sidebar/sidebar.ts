import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import type { NavItem } from '../../../models/nav-item.model';
import { Button } from '../../../shared/components/button/button';
import { Icon } from '../../../shared/components/icon/icon';

@Component({
  selector: 'app-sidebar',
  imports: [RouterLink, RouterLinkActive, Button, Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'contents' },
  templateUrl: './sidebar.html',
})
export class Sidebar {
  readonly items = input.required<readonly NavItem[]>();
  readonly open = input(false);
  /** Emitido quando o utilizador pede para fechar (botão, navegação). */
  readonly closed = output();
}
