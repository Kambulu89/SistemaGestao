import type { Readable } from 'node:stream'
import type { ContentScanner, ScanVerdict } from '#modules/documents/application/ports'

/** Assinatura de teste padrão da indústria (EICAR): inofensiva, mas qualquer antivírus a reconhece. */
export const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*'

/**
 * Analisador mínimo por assinaturas. **Não é um antivírus**: reconhece a assinatura EICAR e serve para exercer o fluxo
 * de quarentena. Em produção a porta `ContentScanner` deve ser servida por um motor real (por exemplo, ClamAV), que é
 * uma decisão de infraestrutura em aberto.
 */
export class SignatureScanner implements ContentScanner {
  private readonly signatures = [{ name: 'EICAR-Test-File', bytes: Buffer.from(EICAR, 'latin1') }]

  async scan(open: () => Readable): Promise<ScanVerdict> {
    const longest = Math.max(...this.signatures.map((s) => s.bytes.length))
    let carry = Buffer.alloc(0)
    for await (const chunk of open()) {
      const window = Buffer.concat([carry, chunk as Buffer])
      for (const signature of this.signatures) {
        if (window.includes(signature.bytes)) return { clean: false, signature: signature.name }
      }
      carry = window.subarray(Math.max(0, window.length - longest + 1))
    }
    return { clean: true }
  }
}
