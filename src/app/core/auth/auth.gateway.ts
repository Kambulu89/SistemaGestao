import type { Observable } from 'rxjs';
import type { Credentials, Session } from './auth.model';

/** Contrato com o backend de identidade. O adapter actual é um mock (core/mock). */
export abstract class AuthGateway {
  abstract login(credentials: Credentials): Observable<Session>;
  abstract requestPasswordReset(email: string): Observable<void>;
}
