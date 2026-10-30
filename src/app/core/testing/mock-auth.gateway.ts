import { Injectable } from '@angular/core';
import type { Observable } from 'rxjs';
import { AuthGateway } from '../auth/auth.gateway';
import type { Credentials, Session } from '../auth/auth.model';
import { MOCK_PASSWORD, MOCK_USERS } from '../mock/mock-data';
import { mockError, respond } from '../mock/mock-helpers';

/**
 * DUPLO DE TESTE do gateway de identidade (não faz parte da aplicação): permite exercitar os guards,
 * a navegação e os módulos sem servidor. A aplicação usa `HttpAuthGateway`.
 */
@Injectable()
export class MockAuthGateway extends AuthGateway {
  login({ email, password }: Credentials): Observable<Session> {
    return respond(() => {
      const user = MOCK_USERS.find((u) => u.email === email.trim().toLowerCase());
      if (!user || password !== MOCK_PASSWORD) {
        throw mockError(401, 'Credenciais inválidas.');
      }
      return {
        user,
        csrfToken: `mock-csrf-${user.id}`,
        expiresAt: new Date(Date.now() + 8 * 3_600_000).toISOString(),
      };
    });
  }

  logout(): Observable<void> {
    return respond(() => undefined);
  }

  restore(): Observable<Session | null> {
    return respond(() => null);
  }

  requestPasswordReset(): Observable<void> {
    return respond(() => undefined);
  }

  resetPassword(): Observable<void> {
    return respond(() => undefined);
  }
}
