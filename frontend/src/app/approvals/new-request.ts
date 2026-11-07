import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { Api } from '../core/api';
import { ErrorAlert } from '../ui/error-alert';
import { Action, Loadable } from '../ui/load';
import { PageHeader } from '../ui/page-header';
import type { RequestDetail } from './types';

interface AvailableWorkflow {
  id: string;
  code: string;
  name: string;
  description: string | null;
  steps: { sequence: number; name: string }[];
}

@Component({
  selector: 'app-new-request',
  imports: [FormsModule, RouterLink, PageHeader, ErrorAlert],
  template: `
    <app-page-header title="Novo pedido de aprovação">
      <a routerLink="/aprovacoes" class="btn-secondary">Voltar</a>
    </app-page-header>
    <app-error-alert [error]="workflows.error()" />
    @if (workflows.value(); as list) {
      @if (list.length === 0) {
        <p class="card text-sm text-muted">
          Não há workflows publicados. Peça a um gestor que publique um.
        </p>
      } @else {
        <form class="card space-y-4" (ngSubmit)="submit()" novalidate>
          <app-error-alert [error]="action.error()" [showDetails]="false" />
          <div>
            <label class="label" for="workflow">Workflow *</label>
            <select id="workflow" name="workflow" class="input" [(ngModel)]="workflowId">
              <option [ngValue]="null">—</option>
              @for (w of list; track w.id) {
                <option [ngValue]="w.id">{{ w.name }} ({{ w.steps.length }} etapa(s))</option>
              }
            </select>
            @if (action.field('workflowId'); as m) {
              <p class="field-error">{{ m }}</p>
            }
          </div>
          <div>
            <label class="label" for="title">Título *</label>
            <input id="title" name="title" class="input" maxlength="200" [(ngModel)]="title" />
            @if (action.field('title'); as m) {
              <p class="field-error">{{ m }}</p>
            }
          </div>
          <div>
            <label class="label" for="description">Descrição</label>
            <textarea
              id="description"
              name="description"
              rows="4"
              class="input"
              [(ngModel)]="description"
            ></textarea>
          </div>
          <p class="text-xs text-muted">
            Depois de submeter, pode anexar documentos no detalhe do pedido.
          </p>
          <button
            type="submit"
            class="btn-primary"
            [disabled]="action.busy() || !workflowId() || !title().trim()"
          >
            Submeter
          </button>
        </form>
      }
    }
  `,
})
export class NewRequest {
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  protected readonly workflowId = signal<string | null>(null);
  protected readonly title = signal('');
  protected readonly description = signal('');
  protected readonly action = new Action();
  protected readonly workflows = new Loadable(() =>
    this.api.get<AvailableWorkflow[]>('approvals/available-workflows'),
  );

  constructor() {
    void this.workflows.load();
  }

  protected async submit() {
    const created = await this.action.run(() =>
      this.api.post<RequestDetail>('approvals/requests', {
        workflowId: this.workflowId(),
        title: this.title().trim(),
        description: this.description().trim() || null,
      }),
    );
    if (created) await this.router.navigate(['/aprovacoes/pedidos', created.id]);
  }
}
