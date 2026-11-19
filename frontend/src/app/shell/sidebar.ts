import { Component, computed, inject, input, output, signal } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { Preferences } from '../core/preferences';
import { Session } from '../core/session';
import { Workspace } from '../core/workspace';
import { Icon } from '../ui/icon';
import { Favorites } from '../core/personal';
import { sectionsOf, visibleNavigation } from './navigation';

/**
 * Navegação principal: favoritos do membro no topo e depois os domínios (com secções), recolhíveis, só com o que o membro pode usar e a empresa contratou. Em ecrã largo pode
 * ficar estreita (só ícones, com o nome em `aria-label` e dica); em ecrã pequeno abre como gaveta.
 */
@Component({
  selector: 'app-sidebar',
  imports: [RouterLink, RouterLinkActive, Icon],
  template: `
    <nav aria-label="Principal" class="flex h-full flex-col">
      <div class="flex items-center justify-between gap-2 px-3 py-4">
        @if (!collapsed()) {
          <a routerLink="/" class="focus-ring truncate rounded text-base font-semibold text-link"
            >Sistema de Gestão</a
          >
        }
        <button
          type="button"
          class="btn-ghost hidden px-2 lg:inline-flex"
          [attr.aria-label]="collapsed() ? 'Expandir menu' : 'Recolher menu'"
          [attr.aria-pressed]="collapsed()"
          (click)="prefs.sidebarCollapsed.set(!prefs.sidebarCollapsed())"
        >
          <app-icon [name]="collapsed() ? 'chevronRight' : 'chevronLeft'" />
        </button>
        <button
          type="button"
          class="btn-ghost px-2 lg:hidden"
          aria-label="Fechar menu"
          (click)="closed.emit()"
        >
          <app-icon name="close" />
        </button>
      </div>
      <div class="flex-1 overflow-y-auto px-2 pb-4">
        @if (favorites.list().length > 0) {
          <div class="mt-1" data-testid="nav-favorites">
            @if (!collapsed()) {
              <p
                class="flex items-center gap-1.5 px-2 py-1 text-xs font-semibold tracking-wide text-muted uppercase"
              >
                <app-icon name="star" [size]="14" /> Favoritos
              </p>
            }
            <ul class="mt-1 space-y-0.5" aria-label="Favoritos">
              @for (f of favorites.list(); track f.path) {
                <li>
                  <a
                    [routerLink]="f.path"
                    routerLinkActive="bg-primary-soft text-on-primary-soft font-medium"
                    #fla="routerLinkActive"
                    [attr.aria-current]="fla.isActive ? 'page' : null"
                    [attr.aria-label]="collapsed() ? f.title : null"
                    [attr.title]="collapsed() ? f.title : null"
                    class="focus-ring flex items-center gap-3 rounded-control px-2 py-1.5 text-sm text-fg hover:bg-surface-2"
                    [class.justify-center]="collapsed()"
                    (click)="navigated.emit()"
                  >
                    <app-icon name="star" />
                    @if (!collapsed()) {
                      <span class="truncate">{{ f.title }}</span>
                    }
                  </a>
                </li>
              }
            </ul>
          </div>
        }
        @for (group of groups(); track group.label) {
          <div class="mt-2">
            @if (!collapsed()) {
              <button
                type="button"
                class="focus-ring flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs font-semibold tracking-wide text-muted uppercase hover:text-fg"
                [attr.aria-expanded]="!folded().has(group.label)"
                [attr.aria-controls]="'grp-' + $index"
                (click)="toggle(group.label)"
              >
                @if (group.icon) {
                  <app-icon [name]="group.icon" [size]="14" />
                }
                <span class="flex-1">{{ group.label }}</span>
                <app-icon
                  [name]="folded().has(group.label) ? 'chevronRight' : 'chevronDown'"
                  [size]="14"
                />
              </button>
            } @else {
              <hr class="mx-2 my-2 border-border" />
            }
            @if (collapsed() || !folded().has(group.label)) {
              <div [id]="'grp-' + $index">
                @for (section of sections(group); track section.title) {
                  @if (section.title && !collapsed()) {
                    <p class="mt-2 px-2 pb-0.5 text-xs text-subtle" aria-hidden="true">
                      {{ section.title }}
                    </p>
                  }
                  <ul
                    class="mt-0.5 space-y-0.5"
                    [attr.aria-label]="
                      section.title ? group.label + ': ' + section.title : group.label
                    "
                  >
                    @for (item of section.items; track item.path) {
                      <li>
                        <a
                          [routerLink]="item.path"
                          routerLinkActive="bg-primary-soft text-on-primary-soft font-medium"
                          [routerLinkActiveOptions]="{
                            exact: item.path === '/aprovacoes' || item.path === '/perfis',
                          }"
                          #rla="routerLinkActive"
                          [attr.aria-current]="rla.isActive ? 'page' : null"
                          [attr.aria-label]="collapsed() ? item.label : null"
                          [attr.title]="collapsed() ? item.label : null"
                          class="focus-ring flex items-center gap-3 rounded-control px-2 py-1.5 text-sm text-fg hover:bg-surface-2"
                          [class.justify-center]="collapsed()"
                          (click)="navigated.emit()"
                        >
                          <app-icon [name]="item.icon" />
                          @if (!collapsed()) {
                            <span class="truncate">{{ item.label }}</span>
                          }
                        </a>
                      </li>
                    }
                  </ul>
                }
              </div>
            }
          </div>
        }
      </div>
    </nav>
  `,
})
export class Sidebar {
  /** Em gaveta (ecrã pequeno) nunca fica estreita. */
  readonly drawer = input(false);
  readonly closed = output();
  readonly navigated = output();
  protected readonly prefs = inject(Preferences);
  protected readonly favorites = inject(Favorites);
  protected readonly sections = sectionsOf;
  private readonly session = inject(Session);
  private readonly workspace = inject(Workspace);
  protected readonly folded = signal<ReadonlySet<string>>(new Set());
  protected readonly collapsed = computed(() => !this.drawer() && this.prefs.sidebarCollapsed());
  protected readonly groups = computed(() =>
    visibleNavigation(
      (p, any) => (any ? this.workspace.canAny(p) : this.workspace.can(p)),
      (f) => this.workspace.has(f),
      this.workspace.context() !== null,
      this.session.user()?.isPlatformAdmin === true,
    ),
  );

  protected toggle(label: string) {
    const next = new Set(this.folded());
    if (next.has(label)) next.delete(label);
    else next.add(label);
    this.folded.set(next);
  }
}
