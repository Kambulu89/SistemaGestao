import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { finalize } from 'rxjs';
import type { ApiError } from '../../../core/api/api-error.model';
import { errorMessage } from '../../../core/api/error-message';
import { PermissionService } from '../../../core/permissions/permission.service';
import { TenantContextService } from '../../../core/tenant-context/tenant-context.service';
import { Alert } from '../../../shared/ui/alert/alert';
import { Badge } from '../../../shared/ui/badge/badge';
import { Button } from '../../../shared/ui/button/button';
import { Card } from '../../../shared/ui/card/card';
import { Dialog } from '../../../shared/ui/dialog/dialog';
import { EmptyState } from '../../../shared/ui/empty-state/empty-state';
import { Input } from '../../../shared/ui/input/input';
import { LoadingState } from '../../../shared/ui/loading-state/loading-state';
import { PageHeader } from '../../../shared/ui/page-header/page-header';
import { Select } from '../../../shared/ui/select/select';
import { Table, type TableColumn } from '../../../shared/ui/table/table';
import {
  IamApi,
  type InvitationDto,
  type InvitationStatus,
  type MemberDto,
  type MemberStatus,
} from '../data-access/iam.api';

type Tone = 'neutral' | 'success' | 'brand' | 'danger';

const MEMBER_STATUS: Record<MemberStatus, { label: string; tone: Tone }> = {
  ACTIVE: { label: 'Activo', tone: 'success' },
  INVITED: { label: 'Convidado', tone: 'brand' },
  SUSPENDED: { label: 'Suspenso', tone: 'danger' },
  LEFT: { label: 'Saiu', tone: 'neutral' },
};

const INVITATION_STATUS: Record<InvitationStatus, { label: string; tone: Tone }> = {
  PENDING: { label: 'Pendente', tone: 'brand' },
  ACCEPTED: { label: 'Aceite', tone: 'success' },
  REVOKED: { label: 'Revogado', tone: 'neutral' },
  EXPIRED: { label: 'Expirado', tone: 'neutral' },
};

type TargetStatus = Exclude<MemberStatus, 'INVITED'>;

const ACTION_LABEL: Record<TargetStatus, string> = {
  SUSPENDED: 'Suspender',
  ACTIVE: 'Reactivar',
  LEFT: 'Terminar',
};

interface PendingChange {
  readonly member: MemberDto;
  readonly status: TargetStatus;
}

/** Membros e convites do tenant activo. A autorização é do servidor; aqui só se esconde o que não se pode usar. */
@Component({
  selector: 'app-tenant-users',
  imports: [
    DatePipe,
    ReactiveFormsModule,
    Alert,
    Badge,
    Button,
    Card,
    Dialog,
    EmptyState,
    Input,
    LoadingState,
    PageHeader,
    Select,
    Table,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    <app-page-header
      title="Utilizadores"
      description="Membros da organização, os seus perfis e os convites enviados."
    />

    @if (notice(); as text) {
      <app-alert tone="success" class="mb-4 block">{{ text }}</app-alert>
    }
    @if (actionError(); as text) {
      <app-alert tone="danger" title="Não foi possível concluir a operação" class="mb-4 block">
        {{ text }}
      </app-alert>
    }

    <div class="mb-3 flex items-center justify-between">
      <h2 class="text-base font-semibold">Membros</h2>
      @if (canInvite()) {
        <app-button (click)="openInvite()">Convidar</app-button>
      }
    </div>

    <app-card [flush]="true">
      @if (members.isLoading() && !members.hasValue()) {
        <app-loading-state label="A carregar membros…" />
      } @else if (members.error()) {
        <div class="p-5">
          <app-alert tone="danger" title="Não foi possível carregar os membros">
            {{ loadError(members.error()) }}
          </app-alert>
        </div>
      } @else if (members.value(); as list) {
        @if (list.length === 0) {
          <app-empty-state icon="users" title="Ainda não há membros" />
        } @else {
          <app-table caption="Membros da organização" [columns]="memberColumns" [rows]="list">
            <ng-template let-row let-column="column">
              @switch (column.key) {
                @case ('name') {
                  <span class="font-medium">{{ row.displayName ?? '—' }}</span>
                  <span class="block text-xs text-fg-muted">{{ row.email }}</span>
                }
                @case ('status') {
                  <app-badge [tone]="memberStatus(row.status).tone">{{
                    memberStatus(row.status).label
                  }}</app-badge>
                }
                @case ('roles') {
                  {{ roleNames(row) }}
                }
                @case ('joinedAt') {
                  {{ row.joinedAt ? (row.joinedAt | date: 'dd/MM/yyyy') : '—' }}
                }
                @case ('actions') {
                  @if (canManage()) {
                    <span class="flex justify-end gap-1">
                      @for (status of actionsFor(row); track status) {
                        <app-button
                          size="sm"
                          [variant]="status === 'LEFT' ? 'danger' : 'secondary'"
                          (click)="ask(row, status)"
                        >
                          {{ actionLabel(status) }}
                        </app-button>
                      }
                    </span>
                  }
                }
              }
            </ng-template>
          </app-table>
        }
      }
    </app-card>

    @if (canListInvitations()) {
      <h2 class="mb-3 mt-8 text-base font-semibold">Convites</h2>
      <app-card [flush]="true">
        @if (invitations.isLoading() && !invitations.hasValue()) {
          <app-loading-state label="A carregar convites…" />
        } @else if (invitations.error()) {
          <div class="p-5">
            <app-alert tone="danger" title="Não foi possível carregar os convites">
              {{ loadError(invitations.error()) }}
            </app-alert>
          </div>
        } @else if (invitations.value(); as list) {
          @if (list.length === 0) {
            <app-empty-state icon="users" title="Sem convites" />
          } @else {
            <app-table caption="Convites enviados" [columns]="invitationColumns" [rows]="list">
              <ng-template let-row let-column="column">
                @switch (column.key) {
                  @case ('status') {
                    <app-badge [tone]="invitationStatus(row.status).tone">{{
                      invitationStatus(row.status).label
                    }}</app-badge>
                  }
                  @case ('expiresAt') {
                    {{ row.expiresAt | date: 'dd/MM/yyyy HH:mm' }}
                  }
                  @case ('actions') {
                    @if (canInvite() && row.status === 'PENDING') {
                      <span class="flex justify-end">
                        <app-button size="sm" variant="secondary" (click)="revoke(row)">
                          Revogar
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
    }

    <app-dialog
      [open]="pending() !== null"
      [title]="pending() ? actionLabel(pending()!.status) + ' membro' : ''"
      (closed)="pending.set(null)"
    >
      @if (pending(); as change) {
        <p>
          {{ actionLabel(change.status) }} <strong>{{ change.member.displayName }}</strong
          >? O acesso é alterado de imediato, apenas nesta organização.
        </p>
      }
      <ng-container dialogActions>
        <app-button variant="secondary" (click)="pending.set(null)">Cancelar</app-button>
        <app-button [loading]="busy()" (click)="confirm()">Confirmar</app-button>
      </ng-container>
    </app-dialog>

    <app-dialog
      [open]="inviting()"
      title="Convidar para a organização"
      (closed)="inviting.set(false)"
    >
      <form [formGroup]="inviteForm" (ngSubmit)="sendInvite()" novalidate class="space-y-3">
        <app-input label="Email" type="email" formControlName="email" [required]="true" />
        @if (roleOptions().length > 0) {
          <app-select
            label="Perfil (opcional)"
            formControlName="roleId"
            placeholder="Sem perfil"
            [options]="roleOptions()"
          />
        }
        <p class="text-xs text-fg-muted">
          O convite segue por email e expira ao fim de 7 dias. O convidado precisa de já ter conta.
        </p>
        <div class="flex justify-end gap-2 pt-2">
          <app-button variant="secondary" (click)="inviting.set(false)">Cancelar</app-button>
          <app-button type="submit" [loading]="busy()">Enviar convite</app-button>
        </div>
      </form>
    </app-dialog>
  `,
})
export class TenantUsers {
  private readonly api = inject(IamApi);
  private readonly permissions = inject(PermissionService);
  private readonly tenantId = inject(TenantContextService).tenant;

  protected readonly canManage = computed(() => this.permissions.can('member.manage'));
  protected readonly canInvite = computed(() => this.permissions.can('member.invite'));
  protected readonly canListInvitations = computed(() => this.permissions.can('member.read'));

  protected readonly memberColumns: readonly TableColumn[] = [
    { key: 'name', label: 'Nome' },
    { key: 'status', label: 'Estado' },
    { key: 'roles', label: 'Perfis' },
    { key: 'joinedAt', label: 'Desde' },
    { key: 'actions', label: 'Acções', align: 'end' },
  ];
  protected readonly invitationColumns: readonly TableColumn[] = [
    { key: 'email', label: 'Email' },
    { key: 'status', label: 'Estado' },
    { key: 'expiresAt', label: 'Expira em' },
    { key: 'actions', label: 'Acções', align: 'end' },
  ];

  // Os `params` ligam as listas ao tenant: trocar de tenant volta a pedir e cancela o pedido antigo.
  protected readonly members = rxResource({
    params: () => this.tenantId()?.id,
    stream: () => this.api.listMembers(),
  });
  protected readonly invitations = rxResource({
    params: () => (this.canListInvitations() ? this.tenantId()?.id : undefined),
    stream: () => this.api.listInvitations(),
  });
  private readonly roles = rxResource({
    params: () => (this.permissions.can('iam.read') ? this.tenantId()?.id : undefined),
    stream: () => this.api.listRoles(),
  });

  protected readonly roleOptions = computed(() =>
    (this.roles.hasValue() ? this.roles.value() : []).map((r) => ({ value: r.id, label: r.name })),
  );

  protected readonly pending = signal<PendingChange | null>(null);
  protected readonly inviting = signal(false);
  protected readonly busy = signal(false);
  protected readonly notice = signal<string | null>(null);
  protected readonly actionError = signal<string | null>(null);

  protected readonly inviteForm = inject(NonNullableFormBuilder).group({
    email: ['', [Validators.required, Validators.email]],
    roleId: [''],
  });

  protected memberStatus(status: MemberStatus) {
    return MEMBER_STATUS[status];
  }

  protected invitationStatus(status: InvitationStatus) {
    return INVITATION_STATUS[status];
  }

  protected actionLabel(status: TargetStatus): string {
    return ACTION_LABEL[status];
  }

  protected roleNames(member: MemberDto): string {
    return member.roles.map((r) => r.roleCode).join(', ') || '—';
  }

  /** Transições que o servidor aceita a partir do estado actual. */
  protected actionsFor(member: MemberDto): readonly TargetStatus[] {
    switch (member.status) {
      case 'ACTIVE':
        return ['SUSPENDED', 'LEFT'];
      case 'SUSPENDED':
        return ['ACTIVE', 'LEFT'];
      case 'INVITED':
        return ['LEFT'];
      default:
        return [];
    }
  }

  protected loadError(error: unknown): string {
    return errorMessage(error);
  }

  protected ask(member: MemberDto, status: TargetStatus): void {
    this.clearMessages();
    this.pending.set({ member, status });
  }

  protected confirm(): void {
    const change = this.pending();
    if (!change) return;
    this.busy.set(true);
    this.api
      .changeMemberStatus(change.member, change.status)
      .pipe(finalize(() => this.busy.set(false)))
      .subscribe({
        next: () => {
          this.pending.set(null);
          this.notice.set('Membro actualizado.');
          this.members.reload();
        },
        error: (error: ApiError) => {
          this.pending.set(null);
          // Outro administrador alterou o membro entretanto: mostra o estado actual antes de insistir.
          if (error.code === 'VERSION_CONFLICT') this.members.reload();
          this.actionError.set(this.explain(error));
        },
      });
  }

  protected revoke(invitation: InvitationDto): void {
    this.clearMessages();
    this.api.revokeInvitation(invitation.id).subscribe({
      next: () => {
        this.notice.set('Convite revogado.');
        this.invitations.reload();
      },
      error: (error: ApiError) => {
        this.invitations.reload();
        this.actionError.set(this.explain(error));
      },
    });
  }

  protected openInvite(): void {
    this.clearMessages();
    this.inviteForm.reset({ email: '', roleId: '' });
    this.inviting.set(true);
  }

  protected sendInvite(): void {
    if (this.inviteForm.invalid) {
      this.inviteForm.markAllAsTouched();
      return;
    }
    const { email, roleId } = this.inviteForm.getRawValue();
    this.busy.set(true);
    this.api
      .invite(email.trim(), roleId ? [roleId] : [])
      .pipe(finalize(() => this.busy.set(false)))
      .subscribe({
        next: () => {
          this.inviting.set(false);
          this.notice.set('Convite enviado.');
          this.invitations.reload();
        },
        error: (error: ApiError) => {
          // Erros por campo vão para o controlo; os restantes (já é membro, convite pendente) ficam no topo.
          const field = error.fieldErrors?.find((d) => d.path === 'email');
          if (field) {
            this.inviteForm.controls.email.setErrors({ server: { message: field.message } });
            this.inviteForm.controls.email.markAsTouched();
            return;
          }
          this.inviting.set(false);
          this.actionError.set(this.explain(error));
        },
      });
  }

  /** Mensagens do servidor, com um complemento para os conflitos que o utilizador pode resolver. */
  private explain(error: ApiError): string {
    switch (error.code) {
      case 'LAST_ADMIN':
        return `${error.message} Atribua primeiro a permissão a outro membro.`;
      case 'VERSION_CONFLICT':
        return 'O registo foi alterado entretanto por outra pessoa. A lista foi actualizada; repita a operação.';
      case 'PERMISSION_DENIED':
        return 'Não tem permissão para esta operação.';
      default:
        return error.message;
    }
  }

  private clearMessages(): void {
    this.notice.set(null);
    this.actionError.set(null);
  }
}
