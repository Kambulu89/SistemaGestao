import { signal } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import type { ApiError } from '../../../core/api/api-error.model';
import { PermissionService } from '../../../core/permissions/permission.service';
import { TenantContextService } from '../../../core/tenant-context/tenant-context.service';
import { IamApi, type InvitationDto, type MemberDto, type RoleDto } from '../data-access/iam.api';
import { TenantUsers } from './users';

const member = (over: Partial<MemberDto> = {}): MemberDto => ({
  id: 'm1',
  userId: 'u1',
  email: 'ana@exemplo.pt',
  displayName: 'Ana Silva',
  status: 'ACTIVE',
  joinedAt: '2026-01-15T10:00:00.000Z',
  authorizationVersion: 1,
  version: 3,
  roles: [{ assignmentId: 'a1', roleId: 'r1', roleCode: 'tenant_admin' }],
  ...over,
});

const invitation = (over: Partial<InvitationDto> = {}): InvitationDto => ({
  id: 'i1',
  email: 'novo@exemplo.pt',
  status: 'PENDING',
  expiresAt: '2026-10-29T10:00:00.000Z',
  roleIds: [],
  version: 1,
  ...over,
});

const role: RoleDto = {
  id: 'r1',
  code: 'leitor',
  name: 'Leitor',
  description: null,
  isSystem: false,
  version: 1,
  permissionCodes: ['party.read'],
};

const apiError = (status: number, code: string, message: string): ApiError => ({
  status,
  code,
  message,
});

describe('TenantUsers', () => {
  let api: {
    listMembers: ReturnType<typeof vi.fn>;
    changeMemberStatus: ReturnType<typeof vi.fn>;
    listInvitations: ReturnType<typeof vi.fn>;
    invite: ReturnType<typeof vi.fn>;
    revokeInvitation: ReturnType<typeof vi.fn>;
    listRoles: ReturnType<typeof vi.fn>;
  };
  let granted: Set<string>;
  const tenant = signal<{ id: string } | null>({ id: 't1' });

  async function render(): Promise<ComponentFixture<TenantUsers>> {
    const fixture = TestBed.createComponent(TenantUsers);
    await fixture.whenStable();
    fixture.detectChanges();
    return fixture;
  }

  const text = (f: ComponentFixture<unknown>) => (f.nativeElement as HTMLElement).textContent ?? '';
  const button = (f: ComponentFixture<unknown>, label: string) =>
    [...(f.nativeElement as HTMLElement).querySelectorAll('button')].find((b) =>
      b.textContent?.includes(label),
    ) as HTMLButtonElement | undefined;

  beforeEach(() => {
    granted = new Set(['member.read', 'member.invite', 'member.manage', 'iam.read']);
    tenant.set({ id: 't1' });
    api = {
      listMembers: vi.fn(() =>
        of([
          member(),
          member({
            id: 'm2',
            displayName: 'Rui',
            email: 'rui@exemplo.pt',
            status: 'SUSPENDED',
            roles: [],
          }),
        ]),
      ),
      changeMemberStatus: vi.fn(() => of(member())),
      listInvitations: vi.fn(() => of([invitation()])),
      invite: vi.fn(() => of(invitation())),
      revokeInvitation: vi.fn(() => of(undefined)),
      listRoles: vi.fn(() => of([role])),
    };
    TestBed.configureTestingModule({
      providers: [
        { provide: IamApi, useValue: api },
        { provide: PermissionService, useValue: { can: (p: string) => granted.has(p) } },
        { provide: TenantContextService, useValue: { tenant } },
      ],
    });
  });

  it('lists members with status, email and roles, and the pending invitations', async () => {
    const f = await render();
    expect(text(f)).toContain('Ana Silva');
    expect(text(f)).toContain('ana@exemplo.pt');
    expect(text(f)).toContain('tenant_admin');
    expect(text(f)).toContain('Activo');
    expect(text(f)).toContain('Suspenso');
    expect(text(f)).toContain('novo@exemplo.pt');
    expect(text(f)).toContain('Pendente');
  });

  it('offers only the transitions the server accepts for each state', async () => {
    const f = await render();
    const rows = [...(f.nativeElement as HTMLElement).querySelectorAll('tbody tr')];
    const labels = (i: number) =>
      Array.from(rows[i]?.querySelectorAll('button') ?? []).map((b) => b.textContent?.trim());
    expect(labels(0)).toEqual(['Suspender', 'Terminar']);
    expect(labels(1)).toEqual(['Reactivar', 'Terminar']);
  });

  it('hides actions and the invite button without the matching permissions', async () => {
    granted = new Set(['member.read']);
    const f = await render();
    expect(button(f, 'Convidar')).toBeUndefined();
    expect(button(f, 'Suspender')).toBeUndefined();
    expect(button(f, 'Revogar')).toBeUndefined();
    expect(text(f)).toContain('Ana Silva');
  });

  it('does not request invitations without member.read', async () => {
    granted = new Set(['member.manage']);
    await render();
    expect(api.listInvitations).not.toHaveBeenCalled();
  });

  it('confirms before changing a member, sends the version, and reloads', async () => {
    const f = await render();
    button(f, 'Suspender')!.click();
    f.detectChanges();
    expect(api.changeMemberStatus).not.toHaveBeenCalled();
    expect(text(f)).toContain('apenas nesta organização');

    button(f, 'Confirmar')!.click();
    await f.whenStable();
    f.detectChanges();

    expect(api.changeMemberStatus).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'm1', version: 3 }),
      'SUSPENDED',
    );
    expect(api.listMembers).toHaveBeenCalledTimes(2);
    expect(text(f)).toContain('Membro actualizado.');
  });

  it('explains LAST_ADMIN and keeps the list as it was', async () => {
    api.changeMemberStatus.mockReturnValue(
      throwError(() =>
        apiError(409, 'LAST_ADMIN', 'O tenant ficaria sem nenhum administrador activo.'),
      ),
    );
    const f = await render();
    button(f, 'Terminar')!.click();
    f.detectChanges();
    button(f, 'Confirmar')!.click();
    await f.whenStable();
    f.detectChanges();

    expect(text(f)).toContain('O tenant ficaria sem nenhum administrador activo.');
    expect(text(f)).toContain('Atribua primeiro a permissão a outro membro.');
    expect(api.listMembers).toHaveBeenCalledTimes(1);
  });

  it('reloads and asks to retry on a version conflict (409)', async () => {
    api.changeMemberStatus.mockReturnValue(
      throwError(() => apiError(409, 'VERSION_CONFLICT', 'O registo foi alterado entretanto.')),
    );
    const f = await render();
    button(f, 'Suspender')!.click();
    f.detectChanges();
    button(f, 'Confirmar')!.click();
    await f.whenStable();
    f.detectChanges();

    expect(text(f)).toContain('alterado entretanto por outra pessoa');
    expect(api.listMembers).toHaveBeenCalledTimes(2);
  });

  it('shows the server error when members cannot be loaded', async () => {
    api.listMembers.mockReturnValue(
      throwError(() => apiError(403, 'PERMISSION_DENIED', 'Não tem permissão para esta operação.')),
    );
    const f = await render();
    expect(text(f)).toContain('Não foi possível carregar os membros');
    expect(text(f)).toContain('Não tem permissão para esta operação.');
  });

  it('shows an empty state', async () => {
    api.listMembers.mockReturnValue(of([]));
    api.listInvitations.mockReturnValue(of([]));
    const f = await render();
    expect(text(f)).toContain('Ainda não há membros');
    expect(text(f)).toContain('Sem convites');
  });

  it('invites by email with an optional role and reloads the invitations', async () => {
    const f = await render();
    button(f, 'Convidar')!.click();
    f.detectChanges();
    const email = (f.nativeElement as HTMLElement).querySelector(
      'input[type=email]',
    ) as HTMLInputElement;
    email.value = ' novo2@exemplo.pt ';
    email.dispatchEvent(new Event('input'));
    f.detectChanges();
    (f.nativeElement as HTMLElement).querySelector('form')!.dispatchEvent(new Event('submit'));
    await f.whenStable();
    f.detectChanges();

    expect(api.invite).toHaveBeenCalledWith('novo2@exemplo.pt', []);
    expect(api.listInvitations).toHaveBeenCalledTimes(2);
    expect(text(f)).toContain('Convite enviado.');
  });

  it('puts an email validation error from the server on the field and keeps the dialog open', async () => {
    api.invite.mockReturnValue(
      throwError(() => ({
        status: 422,
        code: 'VALIDATION_ERROR',
        message: 'Verifique os campos indicados.',
        fieldErrors: [{ path: 'email', code: 'INVALID_EMAIL', message: 'O email não é válido.' }],
      })),
    );
    const f = await render();
    button(f, 'Convidar')!.click();
    f.detectChanges();
    const email = (f.nativeElement as HTMLElement).querySelector(
      'input[type=email]',
    ) as HTMLInputElement;
    email.value = 'a@b.pt';
    email.dispatchEvent(new Event('input'));
    email.dispatchEvent(new Event('blur'));
    f.detectChanges();
    (f.nativeElement as HTMLElement).querySelector('form')!.dispatchEvent(new Event('submit'));
    await f.whenStable();
    f.detectChanges();

    expect(text(f)).toContain('O email não é válido.');
  });

  it('revokes a pending invitation', async () => {
    const f = await render();
    button(f, 'Revogar')!.click();
    await f.whenStable();
    expect(api.revokeInvitation).toHaveBeenCalledWith('i1');
  });

  it('reloads the lists when the tenant changes', async () => {
    const f = await render();
    expect(api.listMembers).toHaveBeenCalledTimes(1);
    tenant.set({ id: 't2' });
    f.detectChanges();
    await f.whenStable();
    expect(api.listMembers).toHaveBeenCalledTimes(2);
  });
});
