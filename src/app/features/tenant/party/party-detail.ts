import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import type { Observable } from 'rxjs';
import { detailedErrorMessage } from '../../../core/api/error-message';
import { PermissionService } from '../../../core/permissions/permission.service';
import { Alert } from '../../../shared/ui/alert/alert';
import { Badge } from '../../../shared/ui/badge/badge';
import { Button } from '../../../shared/ui/button/button';
import { Card } from '../../../shared/ui/card/card';
import { Input } from '../../../shared/ui/input/input';
import { LoadingState } from '../../../shared/ui/loading-state/loading-state';
import { Select, type SelectOption } from '../../../shared/ui/select/select';
import {
  ADDRESS_LABEL,
  CONTACT_LABEL,
  COUNTRY,
  DATE,
  KIND_LABEL,
  STATUS_LABEL,
  reasonsText,
  textOrNull,
  visibleSensitiveFields,
} from './party-model';
import {
  PartyApi,
  type AddressType,
  type ContactType,
  type PartyChanges,
  type PartyDetailDto,
} from './party.api';

const CONTACT_OPTIONS: readonly SelectOption[] = Object.entries(CONTACT_LABEL).map(
  ([value, label]) => ({ value, label }),
);
const ADDRESS_OPTIONS: readonly SelectOption[] = Object.entries(ADDRESS_LABEL).map(
  ([value, label]) => ({ value, label }),
);

type Draft = Record<string, string>;

/** Ficha de uma Party: identificação, contactos, moradas, relações e possíveis duplicados. */
@Component({
  selector: 'app-party-detail',
  imports: [FormsModule, Alert, Badge, Button, Card, Input, LoadingState, Select],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    <app-button variant="secondary" size="sm" (click)="back.emit()">← Voltar à lista</app-button>

    @if (notice(); as text) {
      <app-alert tone="success" class="mt-3 block">{{ text }}</app-alert>
    }
    @if (error(); as text) {
      <app-alert tone="danger" title="Não foi possível concluir a operação" class="mt-3 block">
        {{ text }}
      </app-alert>
    }

    @if (detail.isLoading() && !detail.hasValue()) {
      <app-loading-state label="A carregar ficha…" />
    } @else if (detail.error()) {
      <app-alert tone="danger" title="Não foi possível carregar a ficha" class="mt-3 block">
        {{ describe(detail.error()) }}
      </app-alert>
    } @else if (detail.value(); as party) {
      <div class="mb-4 mt-3 flex flex-wrap items-center gap-3">
        <h2 class="text-lg font-semibold" data-testid="party-name">{{ party.displayName }}</h2>
        <app-badge tone="brand">{{ kindLabel(party.kind) }}</app-badge>
        <app-badge [tone]="party.status === 'ACTIVE' ? 'success' : 'neutral'">{{
          statusLabel(party.status)
        }}</app-badge>
      </div>

      @if (party.possibleDuplicates.length > 0) {
        <app-alert tone="warning" title="Possíveis duplicados" class="mb-4 block">
          <ul data-testid="duplicates">
            @for (d of party.possibleDuplicates; track d.partyId) {
              <li>
                <button type="button" class="underline" (click)="open.emit(d.partyId)">
                  {{ d.displayName }}
                </button>
                — {{ reasons(d.reasons) }}
              </li>
            }
          </ul>
        </app-alert>
      }

      <app-card title="Identificação">
        <div class="grid gap-3 sm:grid-cols-2" data-testid="identity">
          <app-input
            label="Nome a apresentar"
            [ngModel]="draft()['displayName']"
            (ngModelChange)="set('displayName', $event)"
            [disabled]="!canUpdate()"
          />
          <app-input
            label="Referência externa"
            [ngModel]="draft()['externalReference']"
            (ngModelChange)="set('externalReference', $event)"
            [disabled]="!canUpdate()"
          />
          @if (party.person; as person) {
            <app-input
              label="Nomes próprios"
              [ngModel]="draft()['givenNames']"
              (ngModelChange)="set('givenNames', $event)"
              [disabled]="!canUpdate()"
            />
            <app-input
              label="Apelido"
              [ngModel]="draft()['familyName']"
              (ngModelChange)="set('familyName', $event)"
              [disabled]="!canUpdate()"
            />
            @if (sensitive(party).has('birthDate')) {
              <app-input
                label="Data de nascimento"
                type="date"
                [ngModel]="draft()['birthDate']"
                (ngModelChange)="set('birthDate', $event)"
                [disabled]="!canUpdate()"
              />
            }
            @if (sensitive(party).has('nationality')) {
              <app-input
                label="Nacionalidade (ISO-2)"
                [ngModel]="draft()['nationality']"
                (ngModelChange)="set('nationality', $event)"
                [disabled]="!canUpdate()"
              />
            }
            @if (sensitive(party).has('identityType')) {
              <app-input
                label="Tipo de identificação"
                [ngModel]="draft()['identityType']"
                (ngModelChange)="set('identityType', $event)"
                [disabled]="!canUpdate()"
              />
            }
            @if (sensitive(party).has('identityNumber')) {
              <app-input
                label="Número de identificação"
                [ngModel]="draft()['identityNumber']"
                (ngModelChange)="set('identityNumber', $event)"
                [disabled]="!canUpdate()"
              />
            }
            @if (hiddenCount(person) > 0) {
              <p class="text-xs text-fg-muted sm:col-span-2" data-testid="hidden-note">
                Alguns dados pessoais estão ocultos para o seu perfil.
              </p>
            }
          }
          @if (party.organization) {
            <app-input
              label="Denominação legal"
              [ngModel]="draft()['legalName']"
              (ngModelChange)="set('legalName', $event)"
              [disabled]="!canUpdate()"
            />
            <app-input
              label="País fiscal (ISO-2)"
              [ngModel]="draft()['taxCountry']"
              (ngModelChange)="set('taxCountry', $event)"
              [disabled]="!canUpdate()"
            />
            <app-input
              label="NIF"
              [ngModel]="draft()['taxId']"
              (ngModelChange)="set('taxId', $event)"
              [disabled]="!canUpdate()"
            />
            <app-input
              label="Registo comercial"
              [ngModel]="draft()['registrationNumber']"
              (ngModelChange)="set('registrationNumber', $event)"
              [disabled]="!canUpdate()"
            />
          }
        </div>
        @if (canUpdate()) {
          <div class="mt-4 flex gap-2">
            <app-button [loading]="busy()" (click)="save(party)">Guardar</app-button>
            <app-button variant="secondary" [loading]="busy()" (click)="toggleStatus(party)">
              {{ party.status === 'ACTIVE' ? 'Inactivar' : 'Reactivar' }}
            </app-button>
          </div>
        }
      </app-card>

      <app-card title="Contactos" class="mt-4 block">
        <ul class="divide-y divide-line" data-testid="contacts">
          @for (c of party.contacts; track c.id) {
            <li class="flex items-center justify-between gap-3 py-2 text-sm">
              <span>
                <strong>{{ contactLabel(c.type) }}</strong> · {{ c.value }}
                @if (c.label) {
                  <span class="text-fg-muted">({{ c.label }})</span>
                }
                @if (c.isPrimary) {
                  <app-badge tone="success">Principal</app-badge>
                }
              </span>
              @if (canUpdate()) {
                <span class="flex gap-1">
                  @if (!c.isPrimary) {
                    <app-button size="sm" variant="secondary" (click)="makePrimaryContact(c)"
                      >Tornar principal</app-button
                    >
                  }
                  <app-button size="sm" variant="secondary" (click)="removeContact(c.id)"
                    >Remover</app-button
                  >
                </span>
              }
            </li>
          } @empty {
            <li class="py-2 text-sm text-fg-muted">Sem contactos.</li>
          }
        </ul>
        @if (canUpdate()) {
          <div class="mt-3 grid gap-3 sm:grid-cols-4" data-testid="contact-form">
            <app-select
              label="Tipo"
              [options]="contactOptions"
              [ngModel]="contact()['type']"
              (ngModelChange)="setContact('type', $event)"
            />
            <app-input
              label="Valor"
              [ngModel]="contact()['value']"
              (ngModelChange)="setContact('value', $event)"
            />
            <app-input
              label="Etiqueta (opcional)"
              [ngModel]="contact()['label']"
              (ngModelChange)="setContact('label', $event)"
            />
            <div class="self-end pb-2">
              <app-button [loading]="busy()" (click)="addContact(party)"
                >Adicionar contacto</app-button
              >
            </div>
          </div>
        }
      </app-card>

      <app-card title="Moradas" class="mt-4 block">
        <ul class="divide-y divide-line" data-testid="addresses">
          @for (a of party.addresses; track a.id) {
            <li class="flex items-center justify-between gap-3 py-2 text-sm">
              <span>
                <strong>{{ addressLabel(a.type) }}</strong> · {{ a.line1
                }}{{ a.line2 ? ', ' + a.line2 : '' }}, {{ a.postalCode ? a.postalCode + ' ' : ''
                }}{{ a.city }}, {{ a.countryCode }}
                @if (a.isPrimary) {
                  <app-badge tone="success">Principal</app-badge>
                }
              </span>
              @if (canUpdate()) {
                <app-button size="sm" variant="secondary" (click)="removeAddress(a.id)"
                  >Remover</app-button
                >
              }
            </li>
          } @empty {
            <li class="py-2 text-sm text-fg-muted">Sem moradas.</li>
          }
        </ul>
        @if (canUpdate()) {
          <div class="mt-3 grid gap-3 sm:grid-cols-3" data-testid="address-form">
            <app-select
              label="Tipo"
              [options]="addressOptions"
              [ngModel]="address()['type']"
              (ngModelChange)="setAddress('type', $event)"
            />
            <app-input
              label="Morada"
              [ngModel]="address()['line1']"
              (ngModelChange)="setAddress('line1', $event)"
            />
            <app-input
              label="Complemento"
              [ngModel]="address()['line2']"
              (ngModelChange)="setAddress('line2', $event)"
            />
            <app-input
              label="Código postal"
              [ngModel]="address()['postalCode']"
              (ngModelChange)="setAddress('postalCode', $event)"
            />
            <app-input
              label="Localidade"
              [ngModel]="address()['city']"
              (ngModelChange)="setAddress('city', $event)"
            />
            <app-input
              label="País (ISO-2)"
              [ngModel]="address()['countryCode']"
              (ngModelChange)="setAddress('countryCode', $event)"
            />
            <div class="sm:col-span-3">
              <app-button [loading]="busy()" (click)="addAddress(party)"
                >Adicionar morada</app-button
              >
            </div>
          </div>
        }
      </app-card>

      <app-card title="Relações" class="mt-4 block">
        <ul class="divide-y divide-line" data-testid="relationships">
          @for (r of relationships.value() ?? []; track r.id) {
            <li class="flex items-center justify-between gap-3 py-2 text-sm">
              <span>
                {{ r.sourcePartyId === party.id ? 'Esta ficha' : partyName(r.sourcePartyId) }}
                → <strong>{{ r.relationshipType }}</strong> →
                {{ r.targetPartyId === party.id ? 'esta ficha' : partyName(r.targetPartyId) }}
              </span>
              @if (canUpdate()) {
                <app-button size="sm" variant="secondary" (click)="removeRelationship(r.id)"
                  >Remover</app-button
                >
              }
            </li>
          } @empty {
            <li class="py-2 text-sm text-fg-muted">Sem relações.</li>
          }
        </ul>
        @if (canUpdate()) {
          <div class="mt-3 grid gap-3 sm:grid-cols-3" data-testid="relationship-form">
            <app-select
              label="Ficha relacionada"
              placeholder="Seleccione…"
              [options]="targetOptions(party.id)"
              [ngModel]="relation()['targetPartyId']"
              (ngModelChange)="setRelation('targetPartyId', $event)"
            />
            <app-input
              label="Tipo de relação"
              hint="p. ex. empregado de, representante de"
              [ngModel]="relation()['relationshipType']"
              (ngModelChange)="setRelation('relationshipType', $event)"
            />
            <div class="self-end pb-2">
              <app-button [loading]="busy()" (click)="addRelationship(party)"
                >Adicionar relação</app-button
              >
            </div>
          </div>
        }
      </app-card>
    }
  `,
})
export class PartyDetail {
  readonly partyId = input.required<string>();
  readonly back = output();
  readonly open = output<string>();

  private readonly api = inject(PartyApi);
  private readonly permissions = inject(PermissionService);
  protected readonly canUpdate = computed(() => this.permissions.can('party.update'));

  protected readonly contactOptions = CONTACT_OPTIONS;
  protected readonly addressOptions = ADDRESS_OPTIONS;

  protected readonly detail = rxResource({
    params: () => this.partyId(),
    stream: ({ params }) => this.api.get(params),
  });
  protected readonly relationships = rxResource({
    params: () => this.partyId(),
    stream: ({ params }) => this.api.relationships(params),
  });
  // Para escolher o destino de uma relação e nomear os extremos.
  private readonly others = rxResource({
    params: () => true,
    stream: () => this.api.list({ limit: 100, offset: 0 }),
  });

  protected readonly draft = signal<Draft>({});
  protected readonly contact = signal<Draft>({ type: 'EMAIL', value: '', label: '' });
  protected readonly address = signal<Draft>({
    type: 'BILLING',
    line1: '',
    line2: '',
    postalCode: '',
    city: '',
    countryCode: 'PT',
  });
  protected readonly relation = signal<Draft>({ targetPartyId: '', relationshipType: '' });
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly notice = signal<string | null>(null);

  constructor() {
    // O rascunho recomeça sempre que a ficha é (re)carregada.
    effect(() => {
      if (this.detail.hasValue()) this.draft.set(this.draftOf(this.detail.value()));
    });
  }

  private draftOf(party: PartyDetailDto): Draft {
    const text = (v: string | null | undefined) => v ?? '';
    return {
      displayName: party.displayName,
      externalReference: text(party.externalReference),
      givenNames: text(party.person?.givenNames),
      familyName: text(party.person?.familyName),
      birthDate: text(party.person?.birthDate),
      nationality: text(party.person?.nationality),
      identityType: text(party.person?.identityType),
      identityNumber: text(party.person?.identityNumber),
      legalName: text(party.organization?.legalName),
      taxCountry: text(party.organization?.taxCountry),
      taxId: text(party.organization?.taxId),
      registrationNumber: text(party.organization?.registrationNumber),
    };
  }

  protected kindLabel = (kind: keyof typeof KIND_LABEL) => KIND_LABEL[kind];
  protected statusLabel = (status: keyof typeof STATUS_LABEL) => STATUS_LABEL[status];
  protected contactLabel = (type: ContactType) => CONTACT_LABEL[type];
  protected addressLabel = (type: AddressType) => ADDRESS_LABEL[type];
  protected reasons = reasonsText;
  protected describe = (e: unknown) => detailedErrorMessage(e, 'Pedido falhado.');

  protected sensitive(party: PartyDetailDto) {
    return party.person ? visibleSensitiveFields(party.person) : new Set<string>();
  }

  protected hiddenCount(person: NonNullable<PartyDetailDto['person']>): number {
    return 4 - visibleSensitiveFields(person).size;
  }

  protected partyName(id: string): string {
    return (
      (this.others.hasValue() ? this.others.value() : []).find((p) => p.id === id)?.displayName ??
      id.slice(0, 8)
    );
  }

  protected targetOptions(selfId: string): readonly SelectOption[] {
    return (this.others.hasValue() ? this.others.value() : [])
      .filter((p) => p.id !== selfId)
      .map((p) => ({ value: p.id, label: p.displayName }));
  }

  protected set(key: string, value: string | null): void {
    this.draft.update((d) => ({ ...d, [key]: value ?? '' }));
  }
  protected setContact(key: string, value: string | null): void {
    this.contact.update((d) => ({ ...d, [key]: value ?? '' }));
  }
  protected setAddress(key: string, value: string | null): void {
    this.address.update((d) => ({ ...d, [key]: value ?? '' }));
  }
  protected setRelation(key: string, value: string | null): void {
    this.relation.update((d) => ({ ...d, [key]: value ?? '' }));
  }

  protected save(party: PartyDetailDto): void {
    const d = this.draft();
    const issue = this.identityIssue(party, d);
    if (issue) {
      this.error.set(issue);
      return;
    }
    const changes: PartyChanges = {
      displayName: d['displayName']!.trim(),
      externalReference: textOrNull(d['externalReference']!),
      ...(party.person
        ? {
            person: {
              givenNames: d['givenNames']!.trim(),
              familyName: d['familyName']!.trim(),
              // Só se enviam os campos sensíveis que o servidor mostrou: os escondidos não se tocam.
              ...(this.sensitive(party).has('birthDate')
                ? { birthDate: textOrNull(d['birthDate']!) }
                : {}),
              ...(this.sensitive(party).has('nationality')
                ? { nationality: this.upperOrNull(d['nationality']!) }
                : {}),
              ...(this.sensitive(party).has('identityType')
                ? { identityType: textOrNull(d['identityType']!) }
                : {}),
              ...(this.sensitive(party).has('identityNumber')
                ? { identityNumber: textOrNull(d['identityNumber']!) }
                : {}),
            },
          }
        : {}),
      ...(party.organization
        ? {
            organization: {
              legalName: d['legalName']!.trim(),
              taxCountry: this.upperOrNull(d['taxCountry']!),
              taxId: textOrNull(d['taxId']!),
              registrationNumber: textOrNull(d['registrationNumber']!),
            },
          }
        : {}),
    };
    this.run(this.api.update(party, changes), 'Ficha actualizada.');
  }

  private upperOrNull(value: string): string | null {
    const text = textOrNull(value);
    return text ? text.toUpperCase() : null;
  }

  private identityIssue(party: PartyDetailDto, d: Draft): string | null {
    if (!d['displayName']?.trim()) return 'Indique o nome a apresentar.';
    if (party.person && (!d['givenNames']?.trim() || !d['familyName']?.trim()))
      return 'Indique os nomes próprios e o apelido.';
    if (party.organization && !d['legalName']?.trim()) return 'Indique a denominação legal.';
    for (const [key, label] of [
      ['nationality', 'A nacionalidade'],
      ['taxCountry', 'O país fiscal'],
    ] as const) {
      const value = d[key]?.trim();
      if (value && !COUNTRY.test(value)) return `${label} tem de ter 2 letras (ISO-2).`;
    }
    const birth = d['birthDate']?.trim();
    if (birth && !DATE.test(birth)) return 'A data de nascimento tem de ser AAAA-MM-DD.';
    return null;
  }

  protected toggleStatus(party: PartyDetailDto): void {
    this.run(
      this.api.update(party, { status: party.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE' }),
      party.status === 'ACTIVE' ? 'Ficha inactivada.' : 'Ficha reactivada.',
    );
  }

  protected addContact(party: PartyDetailDto): void {
    const c = this.contact();
    if (!c['value']?.trim()) {
      this.error.set('Indique o valor do contacto.');
      return;
    }
    this.run(
      this.api.addContact(party.id, {
        type: c['type'] as ContactType,
        value: c['value'].trim(),
        label: textOrNull(c['label'] ?? ''),
        isPrimary: party.contacts.length === 0,
      }),
      'Contacto adicionado.',
      () => this.contact.set({ type: c['type']!, value: '', label: '' }),
    );
  }

  protected makePrimaryContact(contact: PartyDetailDto['contacts'][number]): void {
    this.run(
      this.api.updateContact(contact, { isPrimary: true }),
      'Contacto principal actualizado.',
    );
  }

  protected removeContact(id: string): void {
    this.run(this.api.removeContact(id), 'Contacto removido.');
  }

  protected addAddress(party: PartyDetailDto): void {
    const a = this.address();
    if (!a['line1']?.trim() || !a['city']?.trim()) {
      this.error.set('Indique a morada e a localidade.');
      return;
    }
    if (!COUNTRY.test(a['countryCode']?.trim() ?? '')) {
      this.error.set('O país tem de ter 2 letras (ISO-2).');
      return;
    }
    this.run(
      this.api.addAddress(party.id, {
        type: a['type'] as AddressType,
        line1: a['line1'].trim(),
        line2: textOrNull(a['line2'] ?? ''),
        city: a['city'].trim(),
        postalCode: textOrNull(a['postalCode'] ?? ''),
        countryCode: a['countryCode']!.trim().toUpperCase(),
        isPrimary: party.addresses.length === 0,
      }),
      'Morada adicionada.',
      () => this.address.set({ ...a, line1: '', line2: '', postalCode: '', city: '' }),
    );
  }

  protected removeAddress(id: string): void {
    this.run(this.api.removeAddress(id), 'Morada removida.');
  }

  protected addRelationship(party: PartyDetailDto): void {
    const r = this.relation();
    if (!r['targetPartyId'] || !r['relationshipType']?.trim()) {
      this.error.set('Escolha a ficha relacionada e indique o tipo de relação.');
      return;
    }
    this.run(
      this.api.addRelationship(party.id, {
        targetPartyId: r['targetPartyId'],
        relationshipType: r['relationshipType'].trim(),
      }),
      'Relação adicionada.',
      () => this.relation.set({ targetPartyId: '', relationshipType: '' }),
    );
  }

  protected removeRelationship(id: string): void {
    this.run(this.api.removeRelationship(id), 'Relação removida.');
  }

  private run(call: Observable<unknown>, message: string, done?: () => void): void {
    this.error.set(null);
    this.notice.set(null);
    this.busy.set(true);
    call.subscribe({
      next: () => {
        this.busy.set(false);
        done?.();
        this.notice.set(message);
        this.detail.reload();
        this.relationships.reload();
      },
      error: (e: unknown) => {
        this.busy.set(false);
        this.error.set(
          (e as { code?: string }).code === 'VERSION_CONFLICT'
            ? 'A ficha foi alterada entretanto por outra pessoa. Foi recarregada; repita a operação.'
            : detailedErrorMessage(e, 'Não foi possível concluir a operação.'),
        );
        // Mostra o estado actual do servidor antes de o utilizador insistir.
        this.detail.reload();
      },
    });
  }
}
