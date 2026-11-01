import { DatePipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { forkJoin, of, type Observable } from 'rxjs';
import { detailedErrorMessage } from '../../../core/api/error-message';
import { PermissionService } from '../../../core/permissions/permission.service';
import { Alert } from '../../../shared/ui/alert/alert';
import { Button } from '../../../shared/ui/button/button';
import { Checkbox } from '../../../shared/ui/checkbox/checkbox';
import { Dialog } from '../../../shared/ui/dialog/dialog';
import { Input } from '../../../shared/ui/input/input';
import { LoadingState } from '../../../shared/ui/loading-state/loading-state';
import { Select, type SelectOption } from '../../../shared/ui/select/select';
import { IamApi, type MemberDto } from '../data-access/iam.api';
import { OrganizationApi, type UnitDto } from '../data-access/organization.api';

/**
 * Perfis e âmbitos de um membro: as atribuições de perfil (opcionalmente restritas a uma unidade e a um período) e os
 * âmbitos de acesso por unidade. É uma vista de gestão; a decisão de acesso continua a ser do servidor.
 */
@Component({
  selector: 'app-member-access-panel',
  imports: [DatePipe, FormsModule, Alert, Button, Checkbox, Dialog, Input, LoadingState, Select],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-dialog
      [open]="member() !== null"
      [wide]="true"
      [title]="'Perfis e âmbitos — ' + (member()?.displayName ?? member()?.email ?? '')"
      (closed)="closed.emit()"
    >
      @if (error(); as text) {
        <app-alert tone="danger" class="mb-3 block">{{ text }}</app-alert>
      }
      @if (data.isLoading() && !data.hasValue()) {
        <app-loading-state label="A carregar…" />
      } @else if (data.error()) {
        <app-alert tone="danger" title="Não foi possível carregar">
          {{ describe(data.error()) }}
        </app-alert>
      } @else if (data.value(); as d) {
        <h3 class="mb-2 text-sm font-semibold">Perfis atribuídos</h3>
        <ul
          class="mb-3 divide-y divide-line rounded-lg border border-line"
          data-testid="assignments"
        >
          @for (a of d.assignments; track a.id) {
            <li class="flex items-center justify-between gap-3 px-3 py-2 text-sm">
              <span>
                <strong>{{ roleName(a.roleId) }}</strong>
                <span class="text-fg-muted">
                  ·
                  {{ a.organizationUnitId ? unitName(a.organizationUnitId) : 'todas as unidades' }}
                  @if (a.validFrom) {
                    · desde {{ a.validFrom | date: 'dd/MM/yyyy' }}
                  }
                  @if (a.validUntil) {
                    · até {{ a.validUntil | date: 'dd/MM/yyyy' }}
                  }
                </span>
              </span>
              @if (canManage()) {
                <app-button size="sm" variant="secondary" (click)="revoke(a.id)"
                  >Revogar</app-button
                >
              }
            </li>
          } @empty {
            <li class="px-3 py-2 text-sm text-fg-muted">Sem perfis atribuídos.</li>
          }
        </ul>
        @if (canManage()) {
          <div class="mb-6 grid gap-3 sm:grid-cols-2" data-testid="assign-form">
            <app-select
              label="Perfil"
              placeholder="Seleccione o perfil"
              [options]="roleOptions()"
              [ngModel]="roleId()"
              (ngModelChange)="roleId.set($event ?? '')"
            />
            <app-select
              label="Unidade (opcional)"
              placeholder="Todas as unidades"
              [options]="unitOptions()"
              [ngModel]="assignUnitId()"
              (ngModelChange)="assignUnitId.set($event ?? '')"
            />
            <app-input
              label="Válido desde (opcional)"
              type="datetime-local"
              [ngModel]="validFrom()"
              (ngModelChange)="validFrom.set($event ?? '')"
            />
            <app-input
              label="Válido até (opcional)"
              type="datetime-local"
              [ngModel]="validUntil()"
              (ngModelChange)="validUntil.set($event ?? '')"
            />
            <div class="sm:col-span-2">
              <app-button [loading]="busy()" (click)="assign()">Atribuir perfil</app-button>
            </div>
          </div>
        }

        <h3 class="mb-2 text-sm font-semibold">Âmbitos de acesso</h3>
        <ul class="mb-3 divide-y divide-line rounded-lg border border-line" data-testid="scopes">
          @for (s of d.scopes; track s.id) {
            <li class="flex items-center justify-between gap-3 px-3 py-2 text-sm">
              <span>
                {{ s.organizationUnitId ? unitName(s.organizationUnitId) : 'Toda a organização' }}
                @if (s.organizationUnitId && s.includeDescendants) {
                  <span class="text-fg-muted">· com sub-unidades</span>
                }
              </span>
              @if (canManage()) {
                <app-button size="sm" variant="secondary" (click)="removeScope(s.id)"
                  >Remover</app-button
                >
              }
            </li>
          } @empty {
            <li class="px-3 py-2 text-sm text-fg-muted">Sem âmbitos definidos.</li>
          }
        </ul>
        @if (canManage()) {
          <div class="grid gap-3 sm:grid-cols-2" data-testid="scope-form">
            <app-select
              label="Unidade"
              placeholder="Toda a organização"
              [options]="unitOptions()"
              [ngModel]="scopeUnitId()"
              (ngModelChange)="scopeUnitId.set($event ?? '')"
            />
            <div class="self-end pb-2">
              <app-checkbox
                label="Incluir sub-unidades"
                [ngModel]="includeDescendants()"
                (ngModelChange)="includeDescendants.set(!!$event)"
              />
            </div>
            <div class="sm:col-span-2">
              <app-button variant="secondary" [loading]="busy()" (click)="addScope()">
                Adicionar âmbito
              </app-button>
            </div>
          </div>
        }
      }
      <ng-container dialogActions>
        <app-button variant="secondary" (click)="closed.emit()">Fechar</app-button>
      </ng-container>
    </app-dialog>
  `,
})
export class MemberAccessPanel {
  readonly member = input<MemberDto | null>(null);
  /** Emitido quando as atribuições mudam, para a lista de membros actualizar a coluna de perfis. */
  readonly changed = output();
  readonly closed = output();

  private readonly iam = inject(IamApi);
  private readonly organization = inject(OrganizationApi);
  private readonly permissions = inject(PermissionService);
  protected readonly canManage = computed(() => this.permissions.can('iam.manage'));

  protected readonly data = rxResource({
    params: () => this.member()?.id,
    stream: ({ params: membershipId }) =>
      forkJoin({
        assignments: this.iam.assignments(membershipId),
        scopes: this.iam.scopes(membershipId),
        roles: this.iam.listRoles(),
        organizations: this.organization.listOrganizations(),
      }),
  });
  // Cada organização tem a sua árvore de unidades; juntam-se para escolher a unidade.
  private readonly units = rxResource({
    params: () => (this.data.hasValue() ? this.data.value().organizations : undefined),
    stream: ({ params }) =>
      params && params.length > 0
        ? forkJoin(params.map((o) => this.organization.listUnits(o.id)))
        : of([] as readonly (readonly UnitDto[])[]),
  });

  protected readonly roleId = signal('');
  protected readonly assignUnitId = signal('');
  protected readonly validFrom = signal('');
  protected readonly validUntil = signal('');
  protected readonly scopeUnitId = signal('');
  protected readonly includeDescendants = signal(false);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  private readonly allUnits = computed<readonly UnitDto[]>(() =>
    this.units.hasValue() ? this.units.value().flat() : [],
  );
  protected readonly unitOptions = computed<readonly SelectOption[]>(() =>
    this.allUnits().map((u) => ({ value: u.id, label: `${u.code} — ${u.name}` })),
  );
  protected readonly roleOptions = computed<readonly SelectOption[]>(() =>
    (this.data.hasValue() ? this.data.value().roles : []).map((r) => ({
      value: r.id,
      label: r.name,
    })),
  );

  protected describe(error: unknown): string {
    return detailedErrorMessage(error, 'Pedido falhado.');
  }

  protected roleName(id: string): string {
    return this.data.hasValue()
      ? (this.data.value().roles.find((r) => r.id === id)?.name ?? id)
      : id;
  }

  protected unitName(id: string): string {
    return this.allUnits().find((u) => u.id === id)?.name ?? id;
  }

  /** `datetime-local` vem em ISO (UTC) do componente de campo; vazio = sem limite. */
  private instant(value: string): string | null {
    return value ? value : null;
  }

  protected assign(): void {
    const member = this.member();
    if (!member) return;
    if (!this.roleId()) {
      this.error.set('Escolha o perfil a atribuir.');
      return;
    }
    const validFrom = this.instant(this.validFrom());
    const validUntil = this.instant(this.validUntil());
    if (validFrom && validUntil && validUntil <= validFrom) {
      this.error.set('«Válido até» tem de ser posterior a «Válido desde».');
      return;
    }
    this.run(
      this.iam.assign({
        membershipId: member.id,
        roleId: this.roleId(),
        organizationUnitId: this.assignUnitId() || null,
        validFrom,
        validUntil,
      }),
      () => {
        this.roleId.set('');
        this.assignUnitId.set('');
        this.validFrom.set('');
        this.validUntil.set('');
        this.changed.emit();
      },
    );
  }

  protected revoke(id: string): void {
    this.run(this.iam.revokeAssignment(id), () => this.changed.emit());
  }

  protected addScope(): void {
    const member = this.member();
    const unitId = this.scopeUnitId();
    const unit = this.allUnits().find((u) => u.id === unitId);
    const organizationId =
      unit?.organizationId ??
      (this.data.hasValue() ? this.data.value().organizations[0]?.id : undefined);
    if (!member || !organizationId) {
      this.error.set('Não há organização onde definir o âmbito.');
      return;
    }
    this.run(
      this.iam.addScope({
        membershipId: member.id,
        organizationId,
        organizationUnitId: unitId || null,
        includeDescendants: unitId ? this.includeDescendants() : false,
      }),
      () => {
        this.scopeUnitId.set('');
        this.includeDescendants.set(false);
      },
    );
  }

  protected removeScope(id: string): void {
    this.run(this.iam.removeScope(id));
  }

  private run(call: Observable<unknown>, done?: () => void): void {
    this.error.set(null);
    this.busy.set(true);
    call.subscribe({
      next: () => {
        this.busy.set(false);
        done?.();
        this.data.reload();
      },
      error: (e: unknown) => {
        this.busy.set(false);
        this.error.set(detailedErrorMessage(e, 'Não foi possível concluir a operação.'));
        this.data.reload();
      },
    });
  }
}
