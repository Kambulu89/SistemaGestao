import { Directive, TemplateRef, ViewContainerRef, effect, inject, input } from '@angular/core';
import { Workspace } from '../core/workspace';

/**
 * Mostra o conteúdo só com a permissão (e a funcionalidade, se indicada):
 * `<button *appCan="'roles.manage'">`, `<section *appCan="'organization.read'; feature: 'organization'">`.
 * É só apresentação: a API decide sempre.
 */
@Directive({ selector: '[appCan]' })
export class PermissionGate {
  readonly appCan = input.required<string | null>();
  readonly appCanFeature = input<string | null>(null);
  private readonly workspace = inject(Workspace);
  private readonly template = inject(TemplateRef);
  private readonly view = inject(ViewContainerRef);
  private shown = false;

  constructor() {
    effect(() => {
      const permission = this.appCan();
      const feature = this.appCanFeature();
      const allowed =
        (!permission || this.workspace.can(permission)) &&
        (!feature || this.workspace.has(feature));
      if (allowed && !this.shown) this.view.createEmbeddedView(this.template);
      if (!allowed && this.shown) this.view.clear();
      this.shown = allowed;
    });
  }
}
