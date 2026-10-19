export interface User {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  /** Permissões ao nível da plataforma (vazio = não é administrador global). */
  readonly platformPermissions: readonly string[];
}

export interface Session {
  readonly user: User;
  readonly accessToken: string;
  /** Data ISO 8601. */
  readonly expiresAt: string;
}

export interface Credentials {
  readonly email: string;
  readonly password: string;
}
