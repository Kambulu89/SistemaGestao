import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, open, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'
import { Transform, type Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { StorageLimitError, type ObjectStorage } from '#modules/documents/application/ports'

/**
 * Armazenamento em disco local, atrás da porta `ObjectStorage`. A chave vem sempre do servidor (`tenant/ano/uuid`); mesmo
 * assim confirma-se que o caminho resolvido fica dentro da raiz. O conteúdo escreve-se num ficheiro parcial e só depois
 * ocupa a chave definitiva, por isso um upload interrompido nunca deixa um ficheiro a meio na chave.
 */
export class LocalObjectStorage implements ObjectStorage {
  private readonly root: string

  constructor(root: string) {
    this.root = resolve(root)
  }

  private pathOf(key: string): string {
    const path = resolve(this.root, key)
    if (!path.startsWith(this.root + sep)) throw new Error('Chave de armazenamento inválida.')
    return path
  }

  async put(key: string, source: Readable, maxBytes: number) {
    const path = this.pathOf(key)
    await mkdir(dirname(path), { recursive: true })
    const partial = `${path}.part-${randomUUID()}`
    const hash = createHash('sha256')
    let size = 0
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        size += chunk.length
        if (size > maxBytes) {
          callback(new StorageLimitError())
          return
        }
        hash.update(chunk)
        callback(null, chunk)
      },
    })
    try {
      await pipeline(source, meter, createWriteStream(partial, { flags: 'wx', mode: 0o600 }))
      await rename(partial, path)
    } catch (error) {
      await rm(partial, { force: true })
      throw error
    }
    return { size, sha256: hash.digest('hex') }
  }

  async putBuffer(key: string, data: Buffer) {
    const path = this.pathOf(key)
    await mkdir(dirname(path), { recursive: true })
    const partial = `${path}.part-${randomUUID()}`
    await writeFile(partial, data, { flag: 'wx', mode: 0o600 })
    await rename(partial, path)
    return { size: data.length, sha256: createHash('sha256').update(data).digest('hex') }
  }

  open(key: string): Readable {
    return createReadStream(this.pathOf(key))
  }

  async head(key: string, bytes: number): Promise<Uint8Array> {
    const handle = await open(this.pathOf(key), 'r')
    try {
      const buffer = Buffer.alloc(bytes)
      const { bytesRead } = await handle.read(buffer, 0, bytes, 0)
      return buffer.subarray(0, bytesRead)
    } finally {
      await handle.close()
    }
  }

  async remove(key: string): Promise<void> {
    await rm(this.pathOf(key), { force: true })
  }
}
