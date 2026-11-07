import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import app from '@adonisjs/core/services/app'
import env from '#start/env'
import { isUuid } from '#shared/db/sql'

/**
 * Armazenamento local (desenvolvimento; sem serviços externos nesta fase). A chave é gerada pelo servidor
 * (`<tenant>/<2 primeiros>/<id>`) e o caminho final é verificado contra a raiz (sem `..`).
 */
export class LocalStorage {
  private root(): string {
    const configured = env.get('ATTACHMENTS_DIR') ?? 'storage/attachments'
    return isAbsolute(configured) ? configured : app.makePath(configured)
  }

  keyFor(tenantId: string, id: string) {
    if (!isUuid(tenantId) || !isUuid(id)) throw new Error('Chave de armazenamento inválida.')
    return `${tenantId}/${id.slice(0, 2)}/${id}`
  }

  private pathOf(key: string) {
    const root = resolve(this.root())
    const path = resolve(join(root, key))
    if (!path.startsWith(root + sep)) throw new Error('Caminho fora do armazenamento.')
    return path
  }

  async put(key: string, content: Buffer) {
    const path = this.pathOf(key)
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await writeFile(path, content, { flag: 'wx', mode: 0o600 })
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      return await readFile(this.pathOf(key))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  async remove(key: string) {
    await rm(this.pathOf(key), { force: true })
  }
}
