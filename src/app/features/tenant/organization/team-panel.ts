import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { type Observable } from 'rxjs';
import { detailedErrorMessage } from '../../../core/api/error-message';
import { PermissionService } from '../../../core/permissions/permission.service';
import { Alert } from '../../../shared/ui/alert/alert';
import { Button } from '../../../shared/ui/button/button';
import { Card } from '../../../shared/ui/card/card';
import { Input } from '../../../shared/ui/input/input';
import { LoadingState } from '../../../shared/ui/loading-state/loading-state';
import { Select, type SelectOption } from '../../../shared/ui/select/select';
import { IamApi } from '../data-access/iam.api';
import { OrganizationApi, type UnitDto } from '../data-access/organization.api';

/** Equipa de uma unidade: membros com período de pertença e designação. Distinta do âmbito de acesso. */
@Component({
  selector: 'app-team-panel',
  imports: [DatePipe, FormsModule, Alert, Button, Card, Input, LoadingState, Select],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    <h2 class="mb-3 mt-8 text-base font-semibold">Equipas</h2>
    <app-card>
      <app-select
        label="Unidade"
        placeholder="Seleccione a unidade"
        [options]="unitOptions()"
        [ngModel]="unitId()"
        (ngModelChange)="unitId.set($event ?? '')"
      />
      @if (error(); as text) {
        <app-alert tone="danger" class="mt-3 block">{{ text }}</app-alert>
      }
      @if (team.value() !== undefined || team.isLoading() || team.error()) {
        @if (team.isLoading() && !team.hasValue()) {
          <app-loading-state label="A carregar equipa…" />
        } @else if (team.error()) {
          <app-alert tone="danger" class="mt-3 block">{{ describe(team.error()) }}</app-alert>
        } @else if (team.value(); as list) {
          <ul class="mt-3 divide-y divide-line rounded-lg border border-line" data-testid="team">
            @for (m of list; track m.id) {
              <li class="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                <span>
                  <strong>{{ memberName(m.membershipId) }}</strong>
                  <span class="text-fg-muted">
                    · desde {{ m.startsOn | date: 'dd/MM/yyyy' }}
                    @if (m.endsOn) {
                      · até {{ m.endsOn | date: 'dd/MM/yyyy' }}
                    }
                    @if (m.roleLabel) {
                      · {{ m.roleLabel }}
                    }
                  </span>
                </span>
                @if (canManage()) {
                  <app-button size="sm" variant="secondary" (click)="remove(m.id)"
                    >Remover</app-button
                  >
                }
              </li>
            } @empty {
              <li class="px-3 py-2 text-sm text-fg-muted">Esta unidade ainda não tem equipa.</li>
            }
          </ul>
          @if (canManage()) {
            <div class="mt-4 grid gap-3 sm:grid-cols-2" data-testid="team-form">
              <app-select
                label="Membro"
                placeholder="Seleccione o membro"
                [options]="memberOptions()"
                [ngModel]="membershipId()"
                (ngModelChange)="membershipId.set($event ?? '')"
              />
              <app-input
                label="Designação (opcional)"
                [ngModel]="roleLabel()"
                (ngModelChange)="roleLabel.set($event ?? '')"
              />
              <app-input
                label="Desde"
                type="date"
                [required]="true"
                [ngModel]="startsOn()"
                (ngModelChange)="startsOn.set($event ?? '')"
              />
              <app-input
                label="Até (opcional)"
                type="date"
                [ngModel]="endsOn()"
                (ngModelChange)="endsOn.set($event ?? '')"
              />
              <div class="sm:col-span-2">
                <app-button [loading]="busy()" (click)="add()">Adicionar à equipa</app-button>
              </div>
            </div>
          }
        }
      }
    </app-card>
  `,
})
export class TeamPanel {
  readonly units = input.required<readonly UnitDto[]>();

  private readonly organization = inject(OrganizationApi);
  private readonly iam = inject(IamApi);
  private readonly permissions = inject(PermissionService);
  protected readonly canManage = computed(() => this.permissions.can('organization.manage'));

  protected readonly unitId = signal('');
  protected readonly membershipId = signal('');
  protected readonly roleLabel = signal('');
  protected readonly startsOn = signal(new Date().toISOString().slice(0, 10));
  protected readonly endsOn = signal('');
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  protected readonly team = rxResource({
    // Ao trocar de organização a unidade escolhida pode já não existir na lista: não se pede a equipa de outra.
    params: () => (this.units().some((u) => u.id === this.unitId()) ? this.unitId() : undefined),
    stream: ({ params }) => this.organization.listTeam(params),
  });
  private readonly members = rxResource({
    params: () => (this.permissions.can('member.read') ? true : undefined),
    stream: () => this.iam.listMembers(),
  });

  protected readonly unitOptions = computed<readonly SelectOption[]>(() =>
    this.units().map((u) => ({ value: u.id, label: `${u.code} — ${u.name}` })),
  );
  protected readonly memberOptions = computed<readonly SelectOption[]>(() =>
    (this.members.hasValue() ? this.members.value() : [])
      .filter((m) => m.status === 'ACTIVE')
      .map((m) => ({ value: m.id, label: m.displayName ?? m.email ?? m.id })),
  );

  protected describe(error: unknown): string {
    return detailedErrorMessage(error, 'Pedido falhado.');
  }

  protected memberName(id: string): string {
    const member = (this.members.hasValue() ? this.members.value() : []).find((m) => m.id === id);
    return member ? (member.displayName ?? member.email ?? id) : id.slice(0, 8);
  }

  protected add(): void {
    if (!this.membershipId()) {
      this.error.set('Escolha o membro a adicionar.');
      return;
    }
    if (!this.startsOn()) {
      this.error.set('Indique a data de início.');
      return;
    }
    if (this.endsOn() && this.endsOn() < this.startsOn()) {
      this.error.set('«Até» não pode ser anterior a «Desde».');
      return;
    }
    this.run(
      this.organization.addTeamMember(this.unitId(), {
        membershipId: this.membershipId(),
        startsOn: this.startsOn(),
        endsOn: this.endsOn() || null,
        roleLabel: this.roleLabel().trim() || null,
      }),
      () => {
        this.membershipId.set('');
        this.roleLabel.set('');
        this.endsOn.set('');
      },
    );
  }

  protected remove(id: string): void {
    this.run(this.organization.removeTeamMember(id));
  }

  private run(call: Observable<unknown>, done?: () => void): void {
    this.error.set(null);
    this.busy.set(true);
    call.subscribe({
      next: () => {
        this.busy.set(false);
        done?.();
        this.team.reload();
      },
      error: (e: unknown) => {
        this.busy.set(false);
        this.error.set(detailedErrorMessage(e, 'Não foi possível concluir a operação.'));
      },
    });
  }
}
