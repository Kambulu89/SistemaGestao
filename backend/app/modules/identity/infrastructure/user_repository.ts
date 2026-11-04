import db from '@adonisjs/lucid/services/db'
import { ApiError } from '#shared/http/api_error'
import { constraintOf } from '#shared/db/sql'
import type { User, UserStatus } from '#modules/identity/domain/user'

interface UserRow {
  id: string
  email: string
  full_name: string
  status: UserStatus
  is_platform_admin: boolean
  last_login_at: Date | null
  version: number
  created_at: Date
  password_hash?: string | null
}

const COLUMNS =
  'id, email, full_name, status, is_platform_admin, last_login_at, version, created_at'
const toUser = (r: UserRow): User => ({
  id: r.id,
  email: r.email,
  fullName: r.full_name,
  status: r.status,
  isPlatformAdmin: r.is_platform_admin,
  lastLoginAt: r.last_login_at,
  version: r.version,
  createdAt: r.created_at,
})

const conn = () => db.connection('runtime')

/** Utilizadores (tabela global). O hash da palavra-passe só sai deste repositório para o verificar. */
export class UserRepository {
  async find(id: string): Promise<User | null> {
    const result = await conn().rawQuery(`select ${COLUMNS} from users where id = ?`, [id])
    const [row] = result.rows as UserRow[]
    return row ? toUser(row) : null
  }

  async findByEmail(email: string): Promise<User | null> {
    const result = await conn().rawQuery(
      `select ${COLUMNS} from users where lower(email) = lower(?)`,
      [email]
    )
    const [row] = result.rows as UserRow[]
    return row ? toUser(row) : null
  }

  async credentials(email: string): Promise<{ user: User; passwordHash: string | null } | null> {
    const result = await conn().rawQuery(
      `select ${COLUMNS}, password_hash from users where lower(email) = lower(?)`,
      [email]
    )
    const [row] = result.rows as UserRow[]
    return row ? { user: toUser(row), passwordHash: row.password_hash ?? null } : null
  }

  async insert(v: {
    email: string
    fullName: string
    passwordHash: string | null
    isPlatformAdmin?: boolean
  }) {
    try {
      const result = await conn().rawQuery(
        `insert into users (email, full_name, password_hash, is_platform_admin) values (?, ?, ?, ?) returning ${COLUMNS}`,
        [v.email, v.fullName, v.passwordHash, v.isPlatformAdmin ?? false] as never[]
      )
      return toUser(result.rows[0] as UserRow)
    } catch (error) {
      if (constraintOf(error) === 'users_email_unique') {
        throw ApiError.conflict('EMAIL_TAKEN', 'Já existe uma conta com este email.')
      }
      throw error
    }
  }

  async touchLogin(id: string) {
    await conn().rawQuery('update users set last_login_at = now() where id = ?', [id])
  }

  async setPassword(id: string, passwordHash: string) {
    await conn().rawQuery(
      'update users set password_hash = ?, version = version + 1, updated_at = now() where id = ?',
      [passwordHash, id]
    )
  }
}
