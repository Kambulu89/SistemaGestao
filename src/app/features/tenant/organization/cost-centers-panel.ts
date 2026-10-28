import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import type { Observable } from 'rxjs';
import { FormsModule } from '@angular/forms';
import { detailedErrorMessage } from '../../../core/api/error-message';
import { PermissionService } from '../../../core/permissions/permission.service';
import { Alert } from '../../../shared/ui/alert/alert';
import { Badge } from '../../../shared/ui/badge/badge';
import { Button } from '../../../shared/ui/button/button';
import { Card } from '../../../shared/ui/card/card';
import { EmptyState } from '../../../shared/ui/empty-state/empty-state';
import { Input } from '../../../shared/ui/input/input';
import { LoadingState } from '../../../shared/ui/loading-state/loading-state';
import { Select, type SelectOption } from '../../../shared/ui/select/select';
import { Table, type TableColumn } from '../../../shared/ui/table/table';
import { IamApi } from '../data-access/iam.api';
import { OrganizationApi, type CostCenterDto } from '../data-access/organization.api';

/** Centros de custo da organização escolhida (código único, árvore opcional, responsável). */
@Component({
  selector: 'app-cost-centers-panel',
  imports: [
    FormsModule,
    Alert,
    Badge,
    Button,
    Card,
    EmptyState,
    Input,
    LoadingState,
    Select,
    Table,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    <h2 class="mb-3 mt-8 text-base font-semibold">Centros de custo</h2>
    @if (error(); as text) {
      <app-alert tone="danger" class="mb-3 block">{{ text }}</app-alert>
    }
    <app-card [flush]="true">
      @if (centers.isLoading() && !centers.hasValue()) {
        <app-loading-state label="A carregar centros de custo…" />
      } @else if (centers.error()) {
        <div class="p-5">
          <app-alert tone="danger" title="Não foi possível carregar os centros de custo">
            {{ describe(centers.error()) }}
          </app-alert>
        </div>
      } @else if (centers.value(); as list) {
        @if (list.length === 0) {
          <app-empty-state icon="building" title="Sem centros de custo nesta organização" />
        } @else {
          <app-table caption="Centros de custo" [columns]="columns" [rows]="list">
            <ng-template let-row let-column="column">
              @switch (column.key) {
                @case ('code') {
                  <code class="rounded bg-surface-muted px-1.5 py-0.5 text-xs">{{ row.code }}</code>
                }
                @case ('parent') {
                  {{ parentName(row) }}
                }
                @case ('responsible') {
                  {{ memberName(row.responsibleMembershipId) }}
                }
                @case ('active') {
                  <app-badge [tone]="row.active ? 'success' : 'neutral'">{{
                    row.active ? 'Activo' : 'Inactivo'
                  }}</app-badge>
                }
                @case ('actions') {
                  @if (canManage()) {
                    <span class="flex justify-end">
                      <app-button size="sm" variant="secondary" (click)="toggle(row)">
                        {{ row.active ? 'Inactivar' : 'Reactivar' }}
                      </app-button>
                    </span>
                  }
                }
                @default {
                  {{ row[column.key] }}
                }
              }
            </ng-template>
          </app-table>
        }
      }
    </app-card>

    @if (canManage()) {
      <app-card class="mt-3 block">
        <div class="grid gap-3 sm:grid-cols-2" data-testid="cost-center-form">
          <app-input
            label="Código"
            [required]="true"
            [ngModel]="code()"
            (ngModelChange)="code.set($event ?? '')"
          />
          <app-input
            label="Nome"
            [required]="true"
            [ngModel]="name()"
            (ngModelChange)="name.set($event ?? '')"
          />
          <app-select
            label="Centro superior"
            placeholder="Nenhum (raiz)"
            [options]="parentOptions()"
            [ngModel]="parentId()"
            (ngModelChange)="parentId.set($event ?? '')"
          />
          <app-select
            label="Responsável"
            placeholder="Sem responsável"
            [options]="memberOptions()"
            [ngModel]="responsibleId()"
            (ngModelChange)="responsibleId.set($event ?? '')"
          />
          <div class="sm:col-span-2">
            <app-button [loading]="busy()" (click)="create()">Criar centro de custo</app-button>
          </div>
        </div>
      </app-card>
    }
  `,
})
export class CostCentersPanel {
  readonly organizationId = input.required<string>();

  private readonly organization = inject(OrganizationApi);
  private readonly iam = inject(IamApi);
  private readonly permissions = inject(PermissionService);
  protected readonly canManage = computed(() => this.permissions.can('organization.manage'));

  protected readonly columns: readonly TableColumn[] = [
    { key: 'code', label: 'Código' },
    { key: 'name', label: 'Nome' },
    { key: 'parent', label: 'Superior' },
    { key: 'responsible', label: 'Responsável' },
    { key: 'active', label: 'Estado' },
    { key: 'actions', label: 'Acções', align: 'end' },
  ];

  protected readonly centers = rxResource({
    params: () => this.organizationId(),
    stream: ({ params }) => this.organization.listCostCenters(params),
  });
  // Os nomes dos responsáveis só se obtêm com `member.read`; sem ele mostra-se o identificador abreviado.
  private readonly members = rxResource({
    params: () => (this.permissions.can('member.read') ? true : undefined),
    stream: () => this.iam.listMembers(),
  });

  protected readonly code = signal('');
  protected readonly name = signal('');
  protected readonly parentId = signal('');
  protected readonly responsibleId = signal('');
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  protected readonly parentOptions = computed<readonly SelectOption[]>(() =>
    (this.centers.hasValue() ? this.centers.value() : []).map((c) => ({
      value: c.id,
      label: `${c.code} — ${c.name}`,
    })),
  );
  protected readonly memberOptions = computed<readonly SelectOption[]>(() =>
    (this.members.hasValue() ? this.members.value() : [])
      .filter((m) => m.status === 'ACTIVE')
      .map((m) => ({ value: m.id, label: m.displayName ?? m.email ?? m.id })),
  );

  protected describe(error: unknown): string {
    return detailedErrorMessage(error, 'Pedido falhado.');
  }

  protected parentName(center: CostCenterDto): string {
    if (!center.parentId) return '—';
    const parent = (this.centers.hasValue() ? this.centers.value() : []).find(
      (c) => c.id === center.parentId,
    );
    return parent ? parent.code : '—';
  }

  protected memberName(id: string | null): string {
    if (!id) return '—';
    const member = (this.members.hasValue() ? this.members.value() : []).find((m) => m.id === id);
    return member ? (member.displayName ?? member.email ?? id) : id.slice(0, 8);
  }

  protected create(): void {
    if (!this.code().trim() || !this.name().trim()) {
      this.error.set('Indique o código e o nome do centro de custo.');
      return;
    }
    this.run(
      this.organization.createCostCenter({
        organizationId: this.organizationId(),
        parentId: this.parentId() || null,
        code: this.code().trim(),
        name: this.name().trim(),
        responsibleMembershipId: this.responsibleId() || null,
      }),
      () => {
        this.code.set('');
        this.name.set('');
        this.parentId.set('');
        this.responsibleId.set('');
      },
    );
  }

  protected toggle(center: CostCenterDto): void {
    this.run(this.organization.updateCostCenter(center, { active: !center.active }));
  }

  private run(call: Observable<unknown>, done?: () => void): void {
    this.error.set(null);
    this.busy.set(true);
    call.subscribe({
      next: () => {
        this.busy.set(false);
        done?.();
        this.centers.reload();
      },
      error: (e: unknown) => {
        this.busy.set(false);
        this.error.set(detailedErrorMessage(e, 'Não foi possível concluir a operação.'));
        // Conflito de versão: mostra o estado actual antes de o utilizador repetir.
        this.centers.reload();
      },
    });
  }
}
