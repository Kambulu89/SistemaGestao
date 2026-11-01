import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
  signal,
  inject,
} from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import type { Observable } from 'rxjs';
import { PermissionService } from '../../../core/permissions/permission.service';
import { Alert } from '../../../shared/ui/alert/alert';
import { Badge } from '../../../shared/ui/badge/badge';
import { Button } from '../../../shared/ui/button/button';
import { Checkbox } from '../../../shared/ui/checkbox/checkbox';
import { Dialog } from '../../../shared/ui/dialog/dialog';
import { LoadingState } from '../../../shared/ui/loading-state/loading-state';
import { Select, type SelectOption } from '../../../shared/ui/select/select';
import {
  CalendarApi,
  type EditScope,
  type EventDetailDto,
  type OccurrenceDto,
  type ParticipantResponse,
  type ResourceDto,
} from './calendar.api';
import { calendarError, describeRule, formatDateTime } from './calendar-model';

export interface PersonOption {
  readonly membershipId: string;
  readonly label: string;
}

const RESPONSE: Readonly<
  Record<ParticipantResponse, { label: string; tone: 'neutral' | 'success' | 'danger' }>
> = {
  PENDING: { label: 'Por responder', tone: 'neutral' },
  ACCEPTED: { label: 'Aceitou', tone: 'success' },
  DECLINED: { label: 'Recusou', tone: 'danger' },
};

/**
 * O evento em detalhe: participantes (com a sua resposta), reservas de recursos e as operações que mudam o evento.
 * Cancelar um evento que se repete pergunta o âmbito; cancelar uma reserva preserva o evento e avisa os participantes.
 */
@Component({
  selector: 'app-event-detail',
  imports: [FormsModule, Alert, Badge, Button, Checkbox, Dialog, LoadingState, Select],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-dialog
      [open]="eventId() !== null"
      [wide]="true"
      [title]="detail.value()?.title ?? 'Evento'"
      (closed)="closed.emit()"
    >
      @if (error(); as text) {
        <app-alert tone="danger" class="mb-3 block" data-testid="detail-error">{{
          text
        }}</app-alert>
      }
      @if (detail.isLoading() && !detail.hasValue()) {
        <app-loading-state label="A carregar o evento…" />
      } @else if (detail.hasValue() && detail.value(); as ev) {
        <div class="space-y-4" data-testid="event-detail">
          <div class="text-sm">
            <p>
              <strong>{{ when() }}</strong>
              @if (ev.status === 'CANCELLED') {
                <app-badge tone="danger" class="ml-2">Cancelado</app-badge>
              } @else if (ev.status === 'TENTATIVE') {
                <app-badge tone="neutral" class="ml-2">Provisório</app-badge>
              }
            </p>
            <p class="text-fg-muted">
              {{ ev.timezone }} · {{ describeRule(ev.recurrenceRule) }}
              @if (occurrence()?.modified) {
                · esta ocorrência foi alterada
              }
            </p>
            @if (ev.description) {
              <p class="mt-2 whitespace-pre-line">{{ ev.description }}</p>
            }
          </div>

          <section>
            <h3 class="mb-1 text-sm font-semibold">Participantes</h3>
            <ul class="space-y-1 text-sm" data-testid="participants">
              @for (p of ev.participants; track p.id) {
                <li class="flex items-center gap-2">
                  <span>{{ nameOf(p.membershipId, p.partyId) }}</span>
                  <app-badge [tone]="response(p.response).tone">{{
                    response(p.response).label
                  }}</app-badge>
                  @if (canManage() && ev.status !== 'CANCELLED') {
                    <button
                      type="button"
                      class="ml-auto text-xs underline"
                      (click)="removeParticipant(ev, p.id)"
                    >
                      Remover
                    </button>
                  }
                </li>
              } @empty {
                <li class="text-fg-muted">Sem participantes.</li>
              }
            </ul>
            @if (ev.status !== 'CANCELLED') {
              <div class="mt-2 flex flex-wrap items-end gap-2">
                @if (canManage() && people().length > 0) {
                  <div class="w-64">
                    <app-select
                      label="Acrescentar participante"
                      [options]="personOptions()"
                      [ngModel]="person()"
                      (ngModelChange)="person.set($event ?? '')"
                    />
                  </div>
                  <app-button size="sm" variant="secondary" (click)="addParticipant(ev)"
                    >Acrescentar</app-button
                  >
                }
                <app-button size="sm" variant="secondary" (click)="respond(ev, 'ACCEPTED')"
                  >Aceitar convite</app-button
                >
                <app-button size="sm" variant="ghost" (click)="respond(ev, 'DECLINED')"
                  >Recusar</app-button
                >
              </div>
            }
          </section>

          <section>
            <h3 class="mb-1 text-sm font-semibold">Recursos reservados</h3>
            <ul class="space-y-1 text-sm" data-testid="bookings">
              @for (b of ev.bookings; track b.id) {
                <li class="flex flex-wrap items-center gap-2">
                  <span>{{ resourceName(b.resourceId) }} · {{ format(b.startsAt) }}</span>
                  @if (b.status === 'HELD') {
                    <app-badge tone="neutral">Provisória</app-badge>
                    @if (canBook()) {
                      <button
                        type="button"
                        class="text-xs underline"
                        (click)="confirmBooking(b.id)"
                      >
                        Confirmar
                      </button>
                    }
                  }
                  @if (canBook()) {
                    <button
                      type="button"
                      class="ml-auto text-xs underline"
                      (click)="cancelBooking(b.id)"
                    >
                      Cancelar reserva
                    </button>
                  }
                </li>
              } @empty {
                <li class="text-fg-muted">Sem reservas.</li>
              }
            </ul>
            @if (canBook() && ev.status !== 'CANCELLED') {
              <div class="mt-2 flex flex-wrap items-end gap-2" data-testid="book-form">
                <div class="w-64">
                  <app-select
                    label="Reservar recurso"
                    [options]="resourceOptions()"
                    [ngModel]="resource()"
                    (ngModelChange)="resource.set($event ?? '')"
                  />
                </div>
                <app-checkbox
                  label="Provisória (30 min)"
                  [ngModel]="hold()"
                  (ngModelChange)="hold.set($event === true)"
                />
                <app-button size="sm" variant="secondary" (click)="book(ev)">Reservar</app-button>
              </div>
            }
          </section>

          @if (canManage() && ev.status !== 'CANCELLED') {
            <section class="border-t border-line pt-3" data-testid="event-actions">
              <div class="flex flex-wrap gap-2">
                <app-button
                  size="sm"
                  variant="secondary"
                  (click)="edit.emit({ event: ev, occurrence: occurrence() })"
                >
                  Editar
                </app-button>
                @if (ev.recurrenceRule && occurrence()) {
                  <app-button size="sm" variant="ghost" (click)="cancel(ev, 'THIS')"
                    >Cancelar só esta</app-button
                  >
                  <app-button size="sm" variant="ghost" (click)="cancel(ev, 'FUTURE')"
                    >Cancelar esta e as seguintes</app-button
                  >
                }
                <app-button size="sm" variant="ghost" (click)="cancel(ev, 'ALL')">
                  {{ ev.recurrenceRule ? 'Cancelar a série' : 'Cancelar evento' }}
                </app-button>
              </div>
            </section>
          }
        </div>
      }
      <ng-container dialogActions>
        <app-button variant="secondary" (click)="closed.emit()">Fechar</app-button>
      </ng-container>
    </app-dialog>
  `,
})
export class EventDetail {
  private readonly api = inject(CalendarApi);
  private readonly permissions = inject(PermissionService);

  readonly eventId = input<string | null>(null);
  readonly occurrence = input<OccurrenceDto | null>(null);
  readonly resources = input<readonly ResourceDto[]>([]);
  readonly people = input<readonly PersonOption[]>([]);
  readonly closed = output();
  readonly changed = output<string>();
  readonly edit = output<{ event: EventDetailDto; occurrence: OccurrenceDto | null }>();

  protected readonly describeRule = describeRule;
  protected readonly format = (iso: string) => formatDateTime(iso);
  protected readonly canManage = computed(() => this.permissions.can('calendar.manage'));
  protected readonly canBook = computed(() => this.permissions.can('resource.book'));
  protected readonly error = signal<string | null>(null);
  protected readonly person = signal('');
  protected readonly resource = signal('');
  protected readonly hold = signal(false);
  private readonly tick = signal(0);

  protected readonly detail = rxResource({
    params: () => {
      const id = this.eventId();
      return id ? { id, tick: this.tick() } : undefined;
    },
    stream: ({ params }) => this.api.event(params.id),
  });

  protected readonly personOptions = computed<readonly SelectOption[]>(() =>
    this.people().map((p) => ({ value: p.membershipId, label: p.label })),
  );
  protected readonly resourceOptions = computed<readonly SelectOption[]>(() =>
    this.resources()
      .filter((r) => r.active)
      .map((r) => ({ value: r.id, label: `${r.name} (${r.capacity})` })),
  );

  protected response = (r: ParticipantResponse) => RESPONSE[r];

  protected when(): string {
    const occurrence = this.occurrence();
    const ev = this.detail.value();
    if (!ev) return '';
    const startsAt = occurrence?.startsAt ?? ev.startsAt;
    const endsAt = occurrence?.endsAt ?? ev.endsAt;
    return `${formatDateTime(startsAt, ev.timezone)} → ${formatDateTime(endsAt, ev.timezone)}`;
  }

  protected nameOf(membershipId: string | null, partyId: string | null): string {
    if (membershipId)
      return this.people().find((p) => p.membershipId === membershipId)?.label ?? 'Membro';
    return partyId ? 'Pessoa externa' : '—';
  }

  protected resourceName = (id: string) =>
    this.resources().find((r) => r.id === id)?.name ?? 'Recurso';

  private act<T>(call: Observable<T>, message: string, close = false): void {
    this.error.set(null);
    call.subscribe({
      next: () => {
        this.tick.update((t) => t + 1);
        this.changed.emit(message);
        if (close) this.closed.emit();
      },
      error: (e: unknown) => this.error.set(calendarError(e, 'A operação falhou.')),
    });
  }

  protected addParticipant(ev: EventDetailDto): void {
    if (!this.person()) return;
    this.act(
      this.api.addParticipant(ev.id, { membershipId: this.person() }),
      'Participante acrescentado.',
    );
    this.person.set('');
  }

  protected removeParticipant(ev: EventDetailDto, id: string): void {
    this.act(this.api.removeParticipant(ev.id, id), 'Participante removido.');
  }

  protected respond(ev: EventDetailDto, response: 'ACCEPTED' | 'DECLINED'): void {
    this.act(
      this.api.respond(ev.id, response),
      response === 'ACCEPTED' ? 'Convite aceite.' : 'Convite recusado.',
    );
  }

  protected book(ev: EventDetailDto): void {
    if (!this.resource()) {
      this.error.set('Escolha o recurso a reservar.');
      return;
    }
    const occurrence = this.occurrence();
    this.act(
      this.api.book({
        eventId: ev.id,
        resourceId: this.resource(),
        // Numa série, reserva-se a ocorrência aberta (reservar todas é pedir sem ocorrência).
        ...(ev.recurrenceRule && occurrence?.occurrenceStart
          ? { occurrenceStart: occurrence.occurrenceStart }
          : {}),
        ...(this.hold() ? { hold: true, holdMinutes: 30 } : {}),
      }),
      'Recurso reservado.',
    );
  }

  protected confirmBooking(id: string): void {
    this.act(this.api.confirmBooking(id), 'Reserva confirmada.');
  }

  protected cancelBooking(id: string): void {
    this.act(
      this.api.cancelBooking(id),
      'Reserva cancelada: o evento mantém-se e os participantes foram avisados.',
    );
  }

  protected cancel(ev: EventDetailDto, scope: EditScope): void {
    const occurrenceStart = this.occurrence()?.occurrenceStart;
    this.act(
      this.api.cancelEvent(ev.id, {
        scope,
        ...(scope !== 'ALL' && occurrenceStart ? { occurrenceStart } : {}),
      }),
      scope === 'ALL' ? 'Evento cancelado e participantes avisados.' : 'Ocorrências canceladas.',
      true,
    );
  }
}
