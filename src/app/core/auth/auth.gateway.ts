import type { Observable } from 'rxjs';
import type { Credentials, Session } from './auth.model';

/** Contrato com o backend de identidade. O adapter real é HTTP (`HttpAuthGateway`). */
export abstract class AuthGateway {
  abstract login(credentials: Credentials): Observable<Session>;
  abstract logout(): Observable<void>;
  /** Recupera a sessão existente (cookie) ao arrancar. `null` = sem sessão. */
  abstract restore(): Observable<Session | null>;
  abstract requestPasswordReset(email: string): Observable<void>;
  abstract resetPassword(token: string, newPassword: string): Observable<void>;
}
