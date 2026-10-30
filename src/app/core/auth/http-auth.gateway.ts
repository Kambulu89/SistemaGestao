import { HttpErrorResponse } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { catchError, map, type Observable, of, switchMap, throwError } from 'rxjs';
import { ApiService } from '../api/api.service';
import { mapPlatformPermissions } from '../permissions/backend-permissions';
import { AuthGateway } from './auth.gateway';
import type { Credentials, Session, User } from './auth.model';

interface UserDto {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
}

interface LoginDto {
  readonly user: UserDto;
  readonly csrfToken: string;
  readonly expiresAt: string;
}

interface MeDto {
  readonly user: UserDto;
  readonly csrfToken: string;
  readonly session: { readonly expiresAt: string };
}

function toUser(dto: UserDto, platformPermissions: readonly string[]): User {
  return { id: dto.id, name: dto.displayName, email: dto.email, platformPermissions };
}

/** Adapter HTTP da identidade (C04). Sessão em cookie `HttpOnly`; nada de tokens em storage. */
@Injectable()
export class HttpAuthGateway extends AuthGateway {
  private readonly api = inject(ApiService);

  login(credentials: Credentials): Observable<Session> {
    return this.api.post<LoginDto>('auth/login', credentials).pipe(
      switchMap((dto) =>
        this.platformPermissions().pipe(
          map((platform) => ({
            user: toUser(dto.user, platform),
            csrfToken: dto.csrfToken,
            expiresAt: dto.expiresAt,
          })),
        ),
      ),
    );
  }

  /**
   * Concessões de plataforma da conta (D-033). Só conveniência de navegação: o servidor volta a verificar
   * cada rota `/platform/*`. Se o pedido falhar, a conta é tratada como não sendo da plataforma.
   */
  private platformPermissions(): Observable<readonly string[]> {
    return this.api.get<{ readonly permissions: readonly string[] }>('platform/me').pipe(
      map((dto) => mapPlatformPermissions(dto.permissions)),
      catchError(() => of<readonly string[]>([])),
    );
  }

  logout(): Observable<void> {
    return this.api.post<void>('auth/logout', {});
  }

  restore(): Observable<Session | null> {
    return this.api.get<MeDto>('me').pipe(
      switchMap((dto) =>
        this.platformPermissions().pipe(
          map((platform) => ({
            user: toUser(dto.user, platform),
            csrfToken: dto.csrfToken,
            expiresAt: dto.session.expiresAt,
          })),
        ),
      ),
      // Sem sessão (401) não é um erro: o utilizador é anónimo.
      catchError((error: unknown) =>
        (error as { status?: number }).status === 401 ||
        (error instanceof HttpErrorResponse && error.status === 401)
          ? of(null)
          : throwError(() => error),
      ),
    );
  }

  requestPasswordReset(email: string): Observable<void> {
    return this.api.post<unknown>('auth/forgot-password', { email }).pipe(map(() => undefined));
  }

  resetPassword(token: string, newPassword: string): Observable<void> {
    return this.api.post<void>('auth/reset-password', { token, newPassword });
  }
}
