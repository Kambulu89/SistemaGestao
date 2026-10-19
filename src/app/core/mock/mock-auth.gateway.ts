import { Injectable } from '@angular/core';
import type { Observable } from 'rxjs';
import { AuthGateway } from '../auth/auth.gateway';
import type { Credentials, Session } from '../auth/auth.model';
import { MOCK_PASSWORD, MOCK_USERS } from './mock-data';
import { mockError, respond } from './mock-helpers';

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
        accessToken: `mock-token-${user.id}`,
        expiresAt: new Date(Date.now() + 8 * 3_600_000).toISOString(),
      };
    });
  }

  requestPasswordReset(): Observable<void> {
    return respond(() => undefined);
  }
}
