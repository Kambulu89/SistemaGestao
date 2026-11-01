import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { of, throwError } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { PermissionService } from '../../../core/permissions/permission.service';
import { TenantContextService } from '../../../core/tenant-context/tenant-context.service';
import { IamApi } from '../data-access/iam.api';
import { NotificationsPage } from './notifications-page';
import {
  NotificationsApi,
  type DeliveryDto,
  type NotificationDto,
  type PreferenceDto,
} from './notifications.api';
import { deliveryErrorText, isHhmm, notificationError } from './notifications-model';

const notification = (over: Partial<NotificationDto> = {}): NotificationDto => ({
  id: 'n1',
  typeCode: 'system.message',
  title: 'Reunião às 10h',
  body: 'Sala 2',
  resourceType: null,
  resourceId: null,
  readAt: null,
  createdAt: '2026-10-01T09:00:00Z',
  ...over,
});

const preference = (over: Partial<PreferenceDto> = {}): PreferenceDto => ({
  typeCode: 'system.message',
  description: 'Avisos do sistema',
  classification: 'OPERATIONAL',
  channel: 'EMAIL',
  enabled: true,
  locked: false,
  quietHours: null,
  ...over,
});

const delivery = (over: Partial<DeliveryDto> = {}): DeliveryDto => ({
  id: 'd1',
  typeCode: 'system.message',
  channel: 'EMAIL',
  destinationHint: 'm***@acme.pt',
  status: 'FAILED',
  provider: 'http',
  attempts: 3,
  lastErrorCode: 'AMBIGUOUS_NO_DEDUPE',
  lastError: 'x',
  nextAttemptAt: '2026-10-01T09:00:00Z',
  sentAt: null,
  deliveredAt: null,
  ...over,
});

function configure(
  api: Record<string, unknown> = {},
  granted: readonly string[] = ['notification.read'],
) {
  const full = {
    list: vi.fn(() => of({ items: [notification()], total: 1, unread: 1 })),
    markRead: vi.fn(() => of(notification({ readAt: '2026-10-01T10:00:00Z' }))),
    markAllRead: vi.fn(() => of({ marked: 1 })),
    open: vi.fn(() => of({ resourceType: 'invoice', resourceId: 'i1', path: 'invoicing' })),
    preferences: vi.fn(() =>
      of([preference(), preference({ typeCode: 'system.mandatory', locked: true })]),
    ),
    updatePreferences: vi.fn(() => of([])),
    deliveries: vi.fn(() => of({ items: [delivery()], total: 1 })),
    retryDelivery: vi.fn(() => of(delivery({ status: 'QUEUED' }))),
    sendMessage: vi.fn(() => of({ requested: 1, duplicates: 0 })),
    ...api,
  };
  const navigate = vi.fn(() => Promise.resolve(true));
  TestBed.configureTestingModule({
    providers: [
      { provide: PermissionService, useValue: { can: (p: string) => granted.includes(p) } },
      { provide: TenantContextService, useValue: { tenant: () => ({ id: 't1', slug: 'acme' }) } },
      { provide: NotificationsApi, useValue: full },
      {
        provide: IamApi,
        useValue: {
          listMembers: () =>
            of([{ id: 'm1', status: 'ACTIVE', displayName: 'Ana', email: 'a@x.pt' }]),
        },
      },
      { provide: Router, useValue: { navigate } },
    ],
  });
  return { full, navigate };
}

async function settle(fixture: { detectChanges(): void; whenStable(): Promise<unknown> }) {
  for (let i = 0; i < 4; i++) {
    fixture.detectChanges();
    await fixture.whenStable();
  }
  fixture.detectChanges();
}

const buttons = (label: string) =>
  [...document.body.querySelectorAll('button')].filter((b) => b.textContent?.trim() === label);
const button = (label: string) => buttons(label)[0]!;
const text = () => document.body.textContent ?? '';

async function open(api: Record<string, unknown> = {}, granted?: readonly string[]) {
  const ctx = configure(api, granted);
  const fixture = TestBed.createComponent(NotificationsPage);
  await settle(fixture);
  return { fixture, ...ctx };
}

describe('modelo', () => {
  it('valida horas e traduz erros', () => {
    expect(isHhmm('22:30')).toBe(true);
    expect(isHhmm('24:00')).toBe(false);
    expect(notificationError({ code: 'RESOURCE_ACCESS_REVOKED' }, 'x')).toContain(
      'Já não tem acesso',
    );
    expect(deliveryErrorText(null, null)).toBe('—');
    expect(deliveryErrorText('AMBIGUOUS_NO_DEDUPE', 'x')).toContain('duplicar');
  });
});

describe('NotificationsPage', () => {
  it('mostra o centro, marca como lida e todas como lidas', async () => {
    const { fixture, full } = await open();
    expect(text()).toContain('Reunião às 10h');
    button('Marcar como lida').click();
    await settle(fixture);
    expect(full.markRead).toHaveBeenCalledWith('n1');
    button('Marcar todas como lidas').click();
    await settle(fixture);
    expect(full.markAllRead).toHaveBeenCalled();
  });

  it('abre o recurso pelo servidor e mostra o erro quando o acesso foi revogado', async () => {
    const withResource = [notification({ resourceType: 'invoice', resourceId: 'i1' })];
    const { fixture, navigate } = await open({
      list: () => of({ items: withResource, total: 1, unread: 1 }),
    });
    button('Abrir').click();
    await settle(fixture);
    expect(navigate).toHaveBeenCalledWith(['/t', 'acme', 'invoicing']);
    TestBed.resetTestingModule();
    const denied = await open({
      list: () => of({ items: withResource, total: 1, unread: 1 }),
      open: () => throwError(() => ({ code: 'RESOURCE_ACCESS_REVOKED' })),
    });
    button('Abrir').click();
    await settle(denied.fixture);
    expect(denied.navigate).not.toHaveBeenCalled();
    expect(text()).toContain('Já não tem acesso ao recurso');
  });

  it('só quem gere a comunicação vê as entregas', async () => {
    await open();
    expect(document.body.querySelector('[data-testid=tab-deliveries]')).toBeNull();
    TestBed.resetTestingModule();
    const { fixture, full } = await open({}, ['notification.read', 'communication.manage']);
    (document.body.querySelector('[data-testid=tab-deliveries]') as HTMLElement).click();
    await settle(fixture);
    expect(text()).toContain('m***@acme.pt');
    expect(text()).toContain('Falhou');
    button('Repetir').click();
    await settle(fixture);
    expect(full.retryDelivery).toHaveBeenCalledWith('d1');
  });

  it('guarda preferências; o aviso obrigatório não se desactiva e as horas são validadas', async () => {
    const { fixture, full } = await open();
    (document.body.querySelector('[data-testid=tab-preferences]') as HTMLElement).click();
    await settle(fixture);
    const boxes = [
      ...document.body.querySelectorAll<HTMLInputElement>(
        '[data-testid=preferences] input[type=checkbox]',
      ),
    ];
    expect(boxes[1]!.disabled).toBe(true);
    boxes[0]!.click();
    await settle(fixture);
    button('Guardar preferências').click();
    await settle(fixture);
    expect(full.updatePreferences).toHaveBeenCalledWith([
      expect.objectContaining({
        typeCode: 'system.message',
        channel: 'EMAIL',
        enabled: false,
        quietHours: null,
      }),
    ]);
  });

  it('envia um aviso a um membro', async () => {
    const { fixture, full } = await open({}, ['notification.read', 'communication.manage']);
    (document.body.querySelector('[data-testid=tab-deliveries]') as HTMLElement).click();
    await settle(fixture);
    button('Enviar aviso').click();
    await settle(fixture);
    const form = document.body.querySelector('[data-testid=send-form]')!;
    const set = (el: HTMLInputElement | HTMLSelectElement, v: string) => {
      el.value = v;
      el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input'));
    };
    set(form.querySelector('select')!, 'm1');
    const inputs = form.querySelectorAll('input[type=text], input:not([type])');
    set(inputs[0] as HTMLInputElement, 'Olá');
    set(inputs[1] as HTMLInputElement, 'Texto');
    await settle(fixture);
    button('Enviar').click();
    await settle(fixture);
    expect(full.sendMessage).toHaveBeenCalledWith({
      typeCode: 'system.message',
      recipientMembershipIds: ['m1'],
      title: 'Olá',
      body: 'Texto',
    });
  });
});
