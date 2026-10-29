import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import type { Observable } from 'rxjs';
import { PermissionService } from '../../../../core/permissions/permission.service';
import { TenantContextService } from '../../../../core/tenant-context/tenant-context.service';
import { Alert } from '../../../../shared/ui/alert/alert';
import { Badge } from '../../../../shared/ui/badge/badge';
import { Button } from '../../../../shared/ui/button/button';
import { Card } from '../../../../shared/ui/card/card';
import { Dialog } from '../../../../shared/ui/dialog/dialog';
import { EmptyState } from '../../../../shared/ui/empty-state/empty-state';
import { Input } from '../../../../shared/ui/input/input';
import { LoadingState } from '../../../../shared/ui/loading-state/loading-state';
import { Select, type SelectOption } from '../../../../shared/ui/select/select';
import { Table, type TableColumn } from '../../../../shared/ui/table/table';
import {
  ProspectingApi,
  type CampaignChannel,
  type CampaignDto,
  type MemberDto,
} from './prospecting.api';
import {
  CAMPAIGN_STATUS,
  CHANNEL,
  formatDecimal,
  isMoney,
  MEMBER_STATUS,
  NEXT_CAMPAIGN_STATUS,
  prospectingError,
  sendSummary,
} from './prospecting-model';

const CHANNEL_OPTIONS: readonly SelectOption[] = (Object.keys(CHANNEL) as CampaignChannel[]).map(
  (value) => ({ value, label: CHANNEL[value] }),
);

/**
 * Campanhas: público, custo e respostas. O envio respeita o consentimento e a lista de exclusão; quem recusa fica de
 * fora de todas as campanhas. A entrega propriamente dita é pedida ao serviço de notificações.
 */
@Component({
  selector: 'app-prospecting-campaigns',
  imports: [
    FormsModule,
    Alert,
    Badge,
    Button,
    Card,
    Dialog,
    EmptyState,
    Input,
    LoadingState,
    Select,
    Table,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="mb-3 flex items-center justify-between">
      <p class="text-sm text-fg-muted">
        Só recebe uma campanha quem não recusou: a lista de exclusão e o consentimento valem para
        todas.
      </p>
      @if (canManage()) {
        <app-button (click)="openCreate()">Nova campanha</app-button>
      }
    </div>
    @if (notice(); as text) {
      <app-alert tone="success" class="mb-3 block" data-testid="notice">{{ text }}</app-alert>
    }
    @if (actionError(); as text) {
      <app-alert tone="danger" class="mb-3 block">{{ text }}</app-alert>
    }
    <app-card [flush]="true">
      @if (campaigns.isLoading() && !campaigns.hasValue()) {
        <app-loading-state label="A carregar campanhas…" />
      } @else if (campaigns.error()) {
        <div class="p-5">
          <app-alert tone="danger" title="Não foi possível carregar as campanhas">
            {{ describe(campaigns.error()) }}
          </app-alert>
        </div>
      } @else if (campaigns.hasValue() && campaigns.value(); as page) {
        @if (page.items.length === 0) {
          <app-empty-state icon="chat" title="Sem campanhas" />
        } @else {
          <app-table caption="Campanhas" [columns]="columns" [rows]="page.items">
            <ng-template let-row let-column="column">
              @switch (column.key) {
                @case ('name') {
                  <span class="font-medium">{{ row.name }}</span>
                  <span class="block text-xs text-fg-muted">{{ channelLabel(row.channel) }}</span>
                }
                @case ('status') {
                  <app-badge [tone]="statusOf(row.status).tone">{{
                    statusOf(row.status).label
                  }}</app-badge>
                }
                @case ('audience') {
                  {{ row.summary.total }} destinatários
                  <span class="block text-xs text-fg-muted">
                    {{ row.summary.contacted }} contactados · {{ row.summary.responded }} respostas
                    · {{ row.summary.optedOut }} recusas
                  </span>
                }
                @case ('budget') {
                  {{ money(row.budget) }} {{ row.currency }}
                }
                @case ('actions') {
                  <span class="flex flex-wrap justify-end gap-1">
                    <app-button size="sm" variant="secondary" (click)="open(row)"
                      >Público</app-button
                    >
                    @if (canManage()) {
                      @for (next of nextStatuses(row); track next.to) {
                        <app-button
                          size="sm"
                          variant="secondary"
                          (click)="setStatus(row, next.to)"
                          >{{ next.label }}</app-button
                        >
                      }
                    }
                    @if (canSend() && row.status === 'ACTIVE') {
                      <app-button size="sm" (click)="send(row)">Enviar</app-button>
                    }
                  </span>
                }
              }
            </ng-template>
          </app-table>
        }
      }
    </app-card>

    @if (selected(); as campaign) {
      <h3 class="mb-2 mt-6 text-sm font-semibold" data-testid="members-title">
        Público de {{ campaign.name }}
      </h3>
      <app-card [flush]="true">
        <ul class="divide-y divide-line" data-testid="members">
          @if (members.hasValue() && members.value(); as list) {
            @for (m of list.items; track m.id) {
              <li class="flex flex-wrap items-center justify-between gap-3 px-4 py-2 text-sm">
                <span>
                  {{ m.leadName ?? m.partyName ?? '—' }}
                  <span class="text-xs text-fg-muted">{{
                    m.leadId ? 'lead' : 'cliente/Party'
                  }}</span>
                </span>
                <span class="flex flex-wrap items-center gap-1">
                  <app-badge [tone]="memberStatus(m.status).tone">{{
                    memberStatus(m.status).label
                  }}</app-badge>
                  @if (canManage()) {
                    @if (m.status === 'TARGETED') {
                      <app-button size="sm" variant="secondary" (click)="removeMember(campaign, m)"
                        >Retirar</app-button
                      >
                    }
                    @if (m.status === 'CONTACTED') {
                      <app-button size="sm" variant="secondary" (click)="respond(campaign, m)"
                        >Respondeu</app-button
                      >
                    }
                    @if (m.status !== 'OPTED_OUT') {
                      <app-button size="sm" variant="secondary" (click)="optOut(campaign, m)"
                        >Recusou</app-button
                      >
                    }
                  }
                </span>
              </li>
            } @empty {
              <li class="px-4 py-2 text-sm text-fg-muted">Ainda sem destinatários.</li>
            }
          }
        </ul>
        @if (canManage() && campaign.status !== 'COMPLETED') {
          <div
            class="flex flex-wrap items-end gap-3 border-t border-line p-3"
            data-testid="member-form"
          >
            <div class="min-w-64 flex-1">
              <app-select
                label="Adicionar lead"
                placeholder="Escolha a lead"
                [options]="leadOptions()"
                [ngModel]="leadId()"
                (ngModelChange)="leadId.set($event ?? '')"
              />
            </div>
            <app-button variant="secondary" [loading]="busy()" (click)="addLead(campaign)"
              >Adicionar</app-button
            >
          </div>
        }
      </app-card>
    }

    <h3 class="mb-2 mt-6 text-sm font-semibold">Lista de exclusão</h3>
    <app-card [flush]="true">
      <ul class="divide-y divide-line" data-testid="exclusions">
        @if (exclusions.hasValue() && exclusions.value(); as list) {
          @for (e of list.items; track e.id) {
            <li class="flex items-center justify-between gap-3 px-4 py-2 text-sm">
              <span>{{ e.kind === 'EMAIL' ? 'Email' : 'Telefone' }} · {{ e.value }}</span>
              @if (canManage()) {
                <app-button size="sm" variant="secondary" (click)="removeExclusion(e.id)"
                  >Retirar</app-button
                >
              }
            </li>
          } @empty {
            <li class="px-4 py-2 text-sm text-fg-muted">Ninguém na lista de exclusão.</li>
          }
        }
      </ul>
      @if (canManage()) {
        <div
          class="flex flex-wrap items-end gap-3 border-t border-line p-3"
          data-testid="exclusion-form"
        >
          <div class="w-40">
            <app-select
              label="Tipo"
              [options]="exclusionKinds"
              [ngModel]="exclusionKind()"
              (ngModelChange)="exclusionKind.set($event ?? 'EMAIL')"
            />
          </div>
          <div class="min-w-56 flex-1">
            <app-input
              label="Valor a excluir"
              [ngModel]="exclusionValue()"
              (ngModelChange)="exclusionValue.set($event ?? '')"
            />
          </div>
          <app-button variant="secondary" [loading]="busy()" (click)="addExclusion()"
            >Acrescentar</app-button
          >
        </div>
      }
    </app-card>

    <app-dialog [open]="creating()" title="Nova campanha" (closed)="creating.set(false)">
      @if (formError(); as text) {
        <app-alert tone="danger" class="mb-3 block">{{ text }}</app-alert>
      }
      <div class="space-y-3" data-testid="campaign-form">
        <app-input label="Nome" [ngModel]="name()" (ngModelChange)="name.set($event ?? '')" />
        <app-select
          label="Canal"
          [options]="channelOptions"
          [ngModel]="channel()"
          (ngModelChange)="channel.set($event ?? 'EMAIL')"
        />
        <app-input
          label="Início (AAAA-MM-DD)"
          [ngModel]="startsOn()"
          (ngModelChange)="startsOn.set($event ?? '')"
        />
        <app-input
          label="Orçamento"
          [ngModel]="budget()"
          (ngModelChange)="budget.set($event ?? '')"
        />
      </div>
      <ng-container dialogActions>
        <app-button variant="secondary" (click)="creating.set(false)">Cancelar</app-button>
        <app-button [loading]="busy()" (click)="create()">Criar</app-button>
      </ng-container>
    </app-dialog>
  `,
})
export class CampaignsTab {
  private readonly api = inject(ProspectingApi);
  private readonly permissions = inject(PermissionService);
  private readonly tenantId = inject(TenantContextService).tenant;

  protected readonly channelOptions = CHANNEL_OPTIONS;
  protected readonly exclusionKinds: readonly SelectOption[] = [
    { value: 'EMAIL', label: 'Email' },
    { value: 'PHONE', label: 'Telefone' },
  ];
  protected readonly canManage = computed(() => this.permissions.can('crm.manage'));
  protected readonly canSend = computed(() => this.permissions.can('campaign.send'));
  protected readonly columns: readonly TableColumn[] = [
    { key: 'name', label: 'Campanha' },
    { key: 'status', label: 'Estado' },
    { key: 'audience', label: 'Público e respostas' },
    { key: 'budget', label: 'Orçamento', align: 'end' },
    { key: 'actions', label: '', align: 'end' },
  ];

  private readonly tick = signal(0);
  protected readonly selected = signal<CampaignDto | null>(null);
  protected readonly busy = signal(false);
  protected readonly notice = signal<string | null>(null);
  protected readonly actionError = signal<string | null>(null);
  protected readonly formError = signal<string | null>(null);

  private readonly scope = () => {
    const tenant = this.tenantId();
    return tenant ? { tenantId: tenant.id, tick: this.tick() } : undefined;
  };
  protected readonly campaigns = rxResource({
    params: this.scope,
    stream: () => this.api.campaigns({ limit: 100 }),
  });
  protected readonly exclusions = rxResource({
    params: this.scope,
    stream: () => this.api.exclusions(),
  });
  protected readonly members = rxResource({
    params: () => {
      const campaign = this.selected();
      return campaign ? { id: campaign.id, tick: this.tick() } : undefined;
    },
    stream: ({ params }) => this.api.members(params.id, { limit: 200 }),
  });
  private readonly leads = rxResource({
    params: () => (this.selected() ? { id: this.selected()?.id } : undefined),
    stream: () => this.api.leads({ limit: 200 }),
  });
  protected readonly leadOptions = computed<readonly SelectOption[]>(() =>
    (this.leads.hasValue() ? this.leads.value().items : []).map((l) => ({
      value: l.id,
      label: `${l.name}${l.email ? ' — ' + l.email : ''}`,
    })),
  );

  protected readonly leadId = signal('');
  protected readonly exclusionKind = signal<string>('EMAIL');
  protected readonly exclusionValue = signal('');

  protected readonly creating = signal(false);
  protected readonly name = signal('');
  protected readonly channel = signal<string>('EMAIL');
  protected readonly startsOn = signal('');
  protected readonly budget = signal('');

  protected money = formatDecimal;
  protected describe = (e: unknown) => prospectingError(e, 'Pedido falhado.');
  protected statusOf = (s: CampaignDto['status']) => CAMPAIGN_STATUS[s];
  protected memberStatus = (s: MemberDto['status']) => MEMBER_STATUS[s];
  protected channelLabel = (c: CampaignChannel) => CHANNEL[c];
  protected nextStatuses = (c: CampaignDto) => NEXT_CAMPAIGN_STATUS[c.status];

  protected open(campaign: CampaignDto): void {
    this.selected.set(campaign);
  }

  protected openCreate(): void {
    this.notice.set(null);
    this.formError.set(null);
    this.name.set('');
    this.channel.set('EMAIL');
    this.startsOn.set(new Date().toISOString().slice(0, 10));
    this.budget.set('');
    this.creating.set(true);
  }

  protected create(): void {
    if (!this.name().trim() || !/^\d{4}-\d{2}-\d{2}$/.test(this.startsOn().trim())) {
      this.formError.set('Indique o nome e a data de início (AAAA-MM-DD).');
      return;
    }
    if (this.budget().trim() && !isMoney(this.budget())) {
      this.formError.set('Orçamento inválido (até 4 casas decimais).');
      return;
    }
    this.formError.set(null);
    this.busy.set(true);
    this.api
      .createCampaign({
        name: this.name().trim(),
        channel: this.channel() as CampaignChannel,
        startsAt: `${this.startsOn().trim()}T00:00:00Z`,
        ...(this.budget().trim() ? { budget: this.budget().trim() } : {}),
      })
      .subscribe({
        next: () => {
          this.busy.set(false);
          this.creating.set(false);
          this.notice.set('Campanha criada em rascunho.');
          this.tick.update((n) => n + 1);
        },
        error: (e: unknown) => {
          this.busy.set(false);
          this.formError.set(prospectingError(e, 'Não foi possível criar a campanha.'));
        },
      });
  }

  protected setStatus(campaign: CampaignDto, to: CampaignDto['status']): void {
    this.run(this.api.setCampaignStatus(campaign.id, to), () => 'Estado da campanha actualizado.');
  }

  protected send(campaign: CampaignDto): void {
    this.run(this.api.send(campaign.id), (result) => `Envio pedido: ${sendSummary(result)}.`);
  }

  protected addLead(campaign: CampaignDto): void {
    if (!this.leadId()) {
      this.actionError.set('Escolha a lead a adicionar.');
      return;
    }
    const id = this.leadId();
    this.run(
      this.api.addMembers(campaign.id, { leadIds: [id] }),
      (r) => (r.added > 0 ? 'Destinatário adicionado.' : 'Esta lead já está na campanha.'),
      () => this.leadId.set(''),
    );
  }

  protected removeMember(campaign: CampaignDto, member: MemberDto): void {
    this.run(this.api.removeMember(campaign.id, member.id), () => 'Destinatário retirado.');
  }

  protected respond(campaign: CampaignDto, member: MemberDto): void {
    this.run(this.api.respondMember(campaign.id, member.id), () => 'Resposta registada.');
  }

  protected optOut(campaign: CampaignDto, member: MemberDto): void {
    this.run(
      this.api.optOutMember(campaign.id, member.id),
      () => 'Recusa registada: o contacto entrou na lista de exclusão.',
    );
  }

  protected addExclusion(): void {
    if (!this.exclusionValue().trim()) {
      this.actionError.set('Indique o email ou telefone a excluir.');
      return;
    }
    this.run(
      this.api.addExclusion({
        kind: this.exclusionKind() as 'EMAIL' | 'PHONE',
        value: this.exclusionValue().trim(),
      }),
      () => 'Acrescentado à lista de exclusão.',
      () => this.exclusionValue.set(''),
    );
  }

  protected removeExclusion(id: string): void {
    this.run(this.api.removeExclusion(id), () => 'Retirado da lista de exclusão.');
  }

  private run<T>(call: Observable<T>, message: (result: T) => string, after?: () => void): void {
    this.notice.set(null);
    this.actionError.set(null);
    this.busy.set(true);
    call.subscribe({
      next: (result) => {
        this.busy.set(false);
        this.notice.set(message(result));
        after?.();
        this.tick.update((n) => n + 1);
      },
      error: (e: unknown) => {
        this.busy.set(false);
        this.actionError.set(prospectingError(e, 'Não foi possível concluir a operação.'));
        this.tick.update((n) => n + 1);
      },
    });
  }
}
