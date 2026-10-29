import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { Router } from '@angular/router';
import { FormsModule } from '@angular/forms';
import type { Observable } from 'rxjs';
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
import { Select, type SelectOption } from '../../../shared/ui/select/select';
import { Table, type TableColumn } from '../../../shared/ui/table/table';
import { IamApi } from '../data-access/iam.api';
import {
  NotificationsApi,
  type Channel,
  type DeliveryDto,
  type DeliveryStatus,
  type NotificationDto,
  type PreferenceDto,
} from './notifications.api';
import {
  CHANNEL_LABEL,
  CLASSIFICATION,
  DELIVERY_STATUS,
  deliveryErrorText,
  isHhmm,
  notificationError,
} from './notifications-model';

type TabId = 'center' | 'preferences' | 'deliveries';

interface PreferenceDraft {
  readonly enabled: boolean;
  readonly start: string;
  readonly end: string;
}

const STATUS_OPTIONS: readonly SelectOption[] = (
  Object.keys(DELIVERY_STATUS) as DeliveryStatus[]
).map((value) => ({ value, label: DELIVERY_STATUS[value].label }));

const key = (p: { typeCode: string; channel: Channel }) => `${p.typeCode}|${p.channel}`;

/**
 * Notificações (S02): o centro de cada pessoa (só vê e só marca as suas), as preferências por tipo e canal e, para quem
 * administra a comunicação, as entregas com dados minimizados.
 */
@Component({
  selector: 'app-notifications-page',
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
    PageHeader,
    Select,
    Table,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-page-header
      title="Notificações"
      description="As suas notificações, as preferências por tipo e canal e, para quem administra, as entregas por canal."
    />
    <div class="mb-5 flex gap-1 border-b border-line" role="tablist" aria-label="Notificações">
      @for (tab of tabs(); track tab.id) {
        <button
          type="button"
          role="tab"
          class="-mb-px border-b-2 px-4 py-2 text-sm font-medium"
          [class.border-brand-600]="active() === tab.id"
          [class.text-brand-700]="active() === tab.id"
          [class.border-transparent]="active() !== tab.id"
          [class.text-fg-muted]="active() !== tab.id"
          [attr.aria-selected]="active() === tab.id"
          [attr.data-testid]="'tab-' + tab.id"
          (click)="selected.set(tab.id)"
        >
          {{ tab.label }}
        </button>
      }
    </div>
    @if (notice(); as text) {
      <app-alert tone="success" class="mb-3 block" data-testid="notice">{{ text }}</app-alert>
    }
    @if (actionError(); as text) {
      <app-alert tone="danger" class="mb-3 block">{{ text }}</app-alert>
    }

    @switch (active()) {
      @case ('center') {
        <div class="mb-3 flex flex-wrap items-center justify-between gap-3">
          <label class="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              data-testid="only-unread"
              [checked]="onlyUnread()"
              (change)="onlyUnread.set(!onlyUnread())"
            />
            Só por ler
          </label>
          <app-button variant="secondary" [disabled]="!hasUnread()" (click)="markAll()"
            >Marcar todas como lidas</app-button
          >
        </div>
        <app-card [flush]="true">
          @if (center.isLoading() && !center.hasValue()) {
            <app-loading-state label="A carregar notificações…" />
          } @else if (center.error()) {
            <div class="p-5">
              <app-alert tone="danger" title="Não foi possível carregar as notificações">
                {{ describe(center.error()) }}
              </app-alert>
            </div>
          } @else if (center.hasValue() && center.value(); as page) {
            @if (page.items.length === 0) {
              <app-empty-state
                icon="info"
                [title]="onlyUnread() ? 'Sem notificações por ler' : 'Sem notificações'"
              />
            } @else {
              <ul class="divide-y divide-line" data-testid="notifications">
                @for (n of page.items; track n.id) {
                  <li class="flex flex-wrap items-start justify-between gap-3 px-4 py-3 text-sm">
                    <span class="min-w-0 flex-1">
                      <span class="block" [class.font-semibold]="!n.readAt">
                        @if (!n.readAt) {
                          <span
                            class="mr-1 inline-block size-2 rounded-full bg-brand-600"
                            aria-label="Por ler"
                          ></span>
                        }
                        {{ n.title }}
                      </span>
                      <span class="block text-fg-muted">{{ n.body }}</span>
                      <span class="block text-xs text-fg-muted">{{
                        n.createdAt.slice(0, 16).replace('T', ' ')
                      }}</span>
                    </span>
                    <span class="flex gap-1">
                      @if (n.resourceId) {
                        <app-button size="sm" (click)="open(n)">Abrir</app-button>
                      }
                      @if (!n.readAt) {
                        <app-button size="sm" variant="secondary" (click)="read(n)"
                          >Marcar como lida</app-button
                        >
                      }
                    </span>
                  </li>
                }
              </ul>
            }
          }
        </app-card>
      }
      @case ('preferences') {
        <p class="mb-3 text-sm text-fg-muted">
          Por omissão recebe tudo. Os avisos obrigatórios não se desactivam e ignoram as horas de
          silêncio, que adiam só as mensagens por canais externos.
        </p>
        <app-card [flush]="true">
          @if (preferences.hasValue() && preferences.value(); as list) {
            <ul class="divide-y divide-line" data-testid="preferences">
              @for (p of list; track keyOf(p)) {
                <li class="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm">
                  <span class="min-w-48 flex-1">
                    {{ p.description }}
                    <span class="block text-xs text-fg-muted">
                      {{ channelLabel(p.channel) }} ·
                      <app-badge [tone]="classOf(p).tone">{{ classOf(p).label }}</app-badge>
                    </span>
                  </span>
                  <label class="flex items-center gap-2">
                    <input
                      type="checkbox"
                      [attr.aria-label]="
                        'Receber ' + p.description + ' por ' + channelLabel(p.channel)
                      "
                      [checked]="draftOf(p).enabled"
                      [disabled]="p.locked"
                      (change)="toggle(p)"
                    />
                    {{ p.locked ? 'Obrigatória' : 'Activa' }}
                  </label>
                  @if (p.channel !== 'IN_APP' && !p.locked) {
                    <span class="flex items-end gap-2">
                      <span class="w-24">
                        <app-input
                          label="Silêncio de"
                          [ngModel]="draftOf(p).start"
                          (ngModelChange)="setQuiet(p, 'start', $event ?? '')"
                        />
                      </span>
                      <span class="w-24">
                        <app-input
                          label="até"
                          [ngModel]="draftOf(p).end"
                          (ngModelChange)="setQuiet(p, 'end', $event ?? '')"
                        />
                      </span>
                    </span>
                  }
                </li>
              }
            </ul>
          }
        </app-card>
        <div class="mt-3">
          <app-button [loading]="busy()" (click)="savePreferences()"
            >Guardar preferências</app-button
          >
        </div>
      }
      @case ('deliveries') {
        <div class="mb-3 flex flex-wrap items-end justify-between gap-3">
          <div class="min-w-56">
            <app-select
              label="Estado"
              placeholder="Todos"
              [options]="statusOptions"
              [ngModel]="status()"
              (ngModelChange)="status.set($event ?? '')"
            />
          </div>
          <app-button (click)="openSend()">Enviar aviso</app-button>
        </div>
        <app-card [flush]="true">
          @if (deliveries.hasValue() && deliveries.value(); as page) {
            @if (page.items.length === 0) {
              <app-empty-state icon="info" title="Sem entregas" />
            } @else {
              <app-table caption="Entregas" [columns]="deliveryColumns" [rows]="page.items">
                <ng-template let-row let-column="column">
                  @switch (column.key) {
                    @case ('type') {
                      {{ row.typeCode }}
                    }
                    @case ('channel') {
                      {{ channelLabel(row.channel) }}
                      <span class="block text-xs text-fg-muted">{{
                        row.destinationHint ?? '—'
                      }}</span>
                    }
                    @case ('status') {
                      <app-badge [tone]="deliveryStatus(row.status).tone">{{
                        deliveryStatus(row.status).label
                      }}</app-badge>
                    }
                    @case ('attempts') {
                      {{ row.attempts }}
                    }
                    @case ('error') {
                      {{ errorText(row) }}
                    }
                    @case ('actions') {
                      @if (row.status === 'FAILED') {
                        <span class="flex justify-end">
                          <app-button size="sm" variant="secondary" (click)="retry(row)"
                            >Repetir</app-button
                          >
                        </span>
                      }
                    }
                  }
                </ng-template>
              </app-table>
            }
          }
        </app-card>
      }
    }

    <app-dialog [open]="sending()" title="Enviar aviso" (closed)="sending.set(false)">
      @if (formError(); as text) {
        <app-alert tone="danger" class="mb-3 block">{{ text }}</app-alert>
      }
      <div class="space-y-3" data-testid="send-form">
        <app-select
          label="Destinatário"
          placeholder="Escolha o membro"
          [options]="memberOptions()"
          [ngModel]="recipient()"
          (ngModelChange)="recipient.set($event ?? '')"
        />
        <app-input label="Título" [ngModel]="title()" (ngModelChange)="title.set($event ?? '')" />
        <app-input label="Texto" [ngModel]="text()" (ngModelChange)="text.set($event ?? '')" />
        <label class="flex items-center gap-2 text-sm">
          <input type="checkbox" [checked]="mandatory()" (change)="mandatory.set(!mandatory())" />
          Aviso obrigatório (ignora as preferências)
        </label>
      </div>
      <ng-container dialogActions>
        <app-button variant="secondary" (click)="sending.set(false)">Cancelar</app-button>
        <app-button [loading]="busy()" (click)="send()">Enviar</app-button>
      </ng-container>
    </app-dialog>
  `,
})
export class NotificationsPage {
  private readonly api = inject(NotificationsApi);
  private readonly iam = inject(IamApi);
  private readonly router = inject(Router);
  private readonly permissions = inject(PermissionService);
  private readonly tenant = inject(TenantContextService).tenant;

  protected readonly statusOptions = STATUS_OPTIONS;
  protected readonly canAdmin = computed(() => this.permissions.can('communication.manage'));
  protected readonly tabs = computed(() => {
    const base: { id: TabId; label: string }[] = [
      { id: 'center', label: 'Centro' },
      { id: 'preferences', label: 'Preferências' },
    ];
    return this.canAdmin() ? [...base, { id: 'deliveries' as const, label: 'Entregas' }] : base;
  });
  protected readonly selected = signal<TabId | null>(null);
  protected readonly active = computed<TabId>(() => this.selected() ?? 'center');
  protected readonly deliveryColumns: readonly TableColumn[] = [
    { key: 'type', label: 'Tipo' },
    { key: 'channel', label: 'Canal e destino' },
    { key: 'status', label: 'Estado' },
    { key: 'attempts', label: 'Tentativas', align: 'end' },
    { key: 'error', label: 'Erro' },
    { key: 'actions', label: '', align: 'end' },
  ];

  private readonly tick = signal(0);
  protected readonly onlyUnread = signal(false);
  protected readonly status = signal('');
  protected readonly busy = signal(false);
  protected readonly notice = signal<string | null>(null);
  protected readonly actionError = signal<string | null>(null);
  protected readonly formError = signal<string | null>(null);

  protected readonly center = rxResource({
    params: () => {
      const t = this.tenant();
      return t ? { tenantId: t.id, unread: this.onlyUnread(), tick: this.tick() } : undefined;
    },
    stream: ({ params }) => this.api.list({ unread: params.unread, limit: 100 }),
  });
  protected readonly hasUnread = computed(
    () => this.center.hasValue() && this.center.value().unread > 0,
  );

  protected readonly preferences = rxResource({
    params: () => {
      const t = this.tenant();
      return t && this.active() === 'preferences'
        ? { tenantId: t.id, tick: this.tick() }
        : undefined;
    },
    stream: () => this.api.preferences(),
  });
  private readonly drafts = signal<ReadonlyMap<string, PreferenceDraft>>(new Map());

  protected readonly deliveries = rxResource({
    params: () => {
      const t = this.tenant();
      return t && this.canAdmin() && this.active() === 'deliveries'
        ? { tenantId: t.id, status: this.status(), tick: this.tick() }
        : undefined;
    },
    stream: ({ params }) =>
      this.api.deliveries(params.status ? { status: params.status as DeliveryStatus } : {}),
  });

  private readonly members = rxResource({
    params: () => (this.sending() ? true : undefined),
    stream: () => this.iam.listMembers(),
  });
  protected readonly memberOptions = computed<readonly SelectOption[]>(() =>
    (this.members.hasValue() ? this.members.value() : [])
      .filter((m) => m.status === 'ACTIVE')
      .map((m) => ({ value: m.id, label: m.displayName ?? m.email ?? m.id.slice(0, 8) })),
  );

  protected readonly sending = signal(false);
  protected readonly recipient = signal('');
  protected readonly title = signal('');
  protected readonly text = signal('');
  protected readonly mandatory = signal(false);

  protected describe = (e: unknown) => notificationError(e, 'Pedido falhado.');
  protected keyOf = key;
  protected channelLabel = (c: Channel) => CHANNEL_LABEL[c];
  protected classOf = (p: PreferenceDto) => CLASSIFICATION[p.classification];
  protected deliveryStatus = (s: DeliveryStatus) => DELIVERY_STATUS[s];
  protected errorText = (d: DeliveryDto) => deliveryErrorText(d.lastErrorCode, d.lastError);

  // --- centro ---------------------------------------------------------------------------------

  protected read(n: NotificationDto): void {
    this.run(this.api.markRead(n.id), 'Marcada como lida.');
  }

  protected markAll(): void {
    this.run(this.api.markAllRead(), 'Todas as suas notificações foram marcadas como lidas.');
  }

  /** O acesso ao recurso revalida-se no servidor ao abrir: sem acesso, mostra-se o erro e nada abre. */
  protected open(n: NotificationDto): void {
    this.notice.set(null);
    this.actionError.set(null);
    this.api.open(n.id).subscribe({
      next: (resource) => {
        const slug = this.tenant()?.slug;
        if (slug) void this.router.navigate(['/t', slug, ...resource.path.split('/')]);
      },
      error: (e: unknown) => {
        this.actionError.set(notificationError(e, 'Não foi possível abrir o recurso.'));
        this.tick.update((i) => i + 1);
      },
    });
  }

  // --- preferências ---------------------------------------------------------------------------

  protected draftOf(p: PreferenceDto): PreferenceDraft {
    return (
      this.drafts().get(key(p)) ?? {
        enabled: p.enabled,
        start: p.quietHours?.start ?? '',
        end: p.quietHours?.end ?? '',
      }
    );
  }

  protected toggle(p: PreferenceDto): void {
    const current = this.draftOf(p);
    this.drafts.update((m) => new Map(m).set(key(p), { ...current, enabled: !current.enabled }));
  }

  protected setQuiet(p: PreferenceDto, field: 'start' | 'end', value: string): void {
    const current = this.draftOf(p);
    this.drafts.update((m) => new Map(m).set(key(p), { ...current, [field]: value }));
  }

  protected savePreferences(): void {
    const list = this.preferences.hasValue() ? this.preferences.value() : [];
    const changes = list.filter((p) => this.drafts().has(key(p)));
    if (changes.length === 0) {
      this.notice.set('Não há alterações para guardar.');
      return;
    }
    const offset = -new Date().getTimezoneOffset();
    const body = [];
    for (const p of changes) {
      const d = this.draftOf(p);
      const wantsQuiet = d.start.trim() !== '' || d.end.trim() !== '';
      if (wantsQuiet && (!isHhmm(d.start) || !isHhmm(d.end) || d.start === d.end)) {
        this.actionError.set(
          'As horas de silêncio têm de ser HH:MM, com o início diferente do fim.',
        );
        return;
      }
      body.push({
        typeCode: p.typeCode,
        channel: p.channel,
        enabled: d.enabled,
        quietHours: wantsQuiet
          ? { start: d.start.trim(), end: d.end.trim(), utcOffsetMinutes: offset }
          : null,
      });
    }
    this.notice.set(null);
    this.actionError.set(null);
    this.busy.set(true);
    this.api.updatePreferences(body).subscribe({
      next: () => {
        this.busy.set(false);
        this.drafts.set(new Map());
        this.notice.set('Preferências guardadas.');
        this.tick.update((i) => i + 1);
      },
      error: (e: unknown) => {
        this.busy.set(false);
        this.actionError.set(notificationError(e, 'Não foi possível guardar as preferências.'));
      },
    });
  }

  // --- administração --------------------------------------------------------------------------

  protected retry(d: DeliveryDto): void {
    this.run(this.api.retryDelivery(d.id), 'Entrega devolvida à fila.');
  }

  protected openSend(): void {
    this.formError.set(null);
    this.recipient.set('');
    this.title.set('');
    this.text.set('');
    this.mandatory.set(false);
    this.sending.set(true);
  }

  protected send(): void {
    if (!this.recipient() || !this.title().trim() || !this.text().trim()) {
      this.formError.set('Indique o destinatário, o título e o texto.');
      return;
    }
    this.formError.set(null);
    this.busy.set(true);
    this.api
      .sendMessage({
        typeCode: this.mandatory() ? 'system.mandatory' : 'system.message',
        recipientMembershipIds: [this.recipient()],
        title: this.title().trim(),
        body: this.text().trim(),
      })
      .subscribe({
        next: () => {
          this.busy.set(false);
          this.sending.set(false);
          this.notice.set('Aviso enviado.');
          this.tick.update((i) => i + 1);
        },
        error: (e: unknown) => {
          this.busy.set(false);
          this.formError.set(notificationError(e, 'Não foi possível enviar o aviso.'));
        },
      });
  }

  private run(call: Observable<unknown>, message: string): void {
    this.notice.set(null);
    this.actionError.set(null);
    call.subscribe({
      next: () => {
        this.notice.set(message);
        this.tick.update((i) => i + 1);
      },
      error: (e: unknown) => {
        this.actionError.set(notificationError(e, 'Não foi possível concluir a operação.'));
        this.tick.update((i) => i + 1);
      },
    });
  }
}
