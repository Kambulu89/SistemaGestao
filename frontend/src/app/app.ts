import { Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { Preferences } from './core/preferences';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet],
  template: `<router-outlet />`,
})
export class App {
  // Aplica tema e densidade desde o primeiro ecrã (incluindo o login).
  protected readonly preferences = inject(Preferences);
}
