import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { of, throwError } from 'rxjs';
import { ApiService } from '../../../core/api/api.service';
import { TenantContextService } from '../../../core/tenant-context/tenant-context.service';
import { loginAs, setupMockBackend } from '../../../core/testing/test-backend';
import { AcceptInvitation } from './accept-invitation';

describe('AcceptInvitation', () => {
  let post: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    post = vi.fn();
    setupMockBackend();
    TestBed.configureTestingModule({ providers: [{ provide: ApiService, useValue: { post } }] });
    await loginAs('multi@demo.pt');
  });

  async function accept(token: string | undefined): Promise<ComponentFixture<AcceptInvitation>> {
    const fixture = TestBed.createComponent(AcceptInvitation);
    fixture.componentRef.setInput('token', token);
    fixture.detectChanges();
    (fixture.nativeElement as HTMLElement).querySelector('button')?.click();
    await fixture.whenStable();
    fixture.detectChanges();
    return fixture;
  }

  it('shows the account being used and refuses a link without token', () => {
    const fixture = TestBed.createComponent(AcceptInvitation);
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain(
      'A ligação do convite é inválida.',
    );
  });

  it('accepts, refreshes the organizations and opens the new one', async () => {
    post.mockReturnValue(of({ tenantId: 't-clinica', membershipId: 'm1' }));
    const refresh = vi.spyOn(TestBed.inject(TenantContextService), 'refreshMemberships');
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);

    await accept('tok'.repeat(10));

    expect(post).toHaveBeenCalledWith('invitations/accept', { token: 'tok'.repeat(10) });
    expect(refresh).toHaveBeenCalled();
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith(['/t', 'clinica-vida']));
  });

  it('shows the same message the server gives for any invalid invitation', async () => {
    post.mockReturnValue(
      throwError(() => ({
        status: 400,
        code: 'INVALID_OR_EXPIRED_TOKEN',
        message: 'O convite é inválido ou expirou.',
      })),
    );
    const fixture = await accept('tok'.repeat(10));
    expect((fixture.nativeElement as HTMLElement).textContent).toContain(
      'O convite é inválido ou expirou.',
    );
  });
});
