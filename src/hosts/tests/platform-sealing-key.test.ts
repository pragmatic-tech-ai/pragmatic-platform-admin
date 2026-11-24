import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SealingKeyPair, SigningKeyPair } from '@pragmatic-tech-ai/pragmatic-hive-protocol'
import { PlatformSealingKey, SealingKeyFileError } from '../platform-sealing-key.js'

class SealingKeyFixture
{
    public static WithFile(content: string | undefined, work: (path: string) => void): void
    {
        const dir = mkdtempSync(join(tmpdir(), 'sealing-key-'))
        try
        {
            const path = join(dir, 'sealing-key.pem')
            if (content !== undefined)
            {
                writeFileSync(path, content)
            }
            work(path)
        }
        finally
        {
            rmSync(dir, { recursive: true, force: true })
        }
    }
}

describe('PlatformSealingKey', () =>
{
    it('reads an X25519 PKCS#8 key; unset is undefined (no hosts)', () =>
    {
        assert.equal(PlatformSealingKey.Of({}), undefined)
        const pair = SealingKeyPair.Generate()
        SealingKeyFixture.WithFile(pair.PrivatePem(), path =>
        {
            const read = PlatformSealingKey.Of({ [PlatformSealingKey.EnvVar]: path })
            assert.ok(read?.PublicKey.Equals(pair.PublicKey))
        })
    })

    it('refuses a missing file and a signing (Ed25519) key, naming the setting only', () =>
    {
        SealingKeyFixture.WithFile(undefined, path =>
        {
            assert.throws(() => PlatformSealingKey.Of({ [PlatformSealingKey.EnvVar]: path }), SealingKeyFileError)
        })
        const signing = SigningKeyPair.Generate().PrivatePem()
        SealingKeyFixture.WithFile(signing, path =>
        {
            assert.throws(() => PlatformSealingKey.Of({ [PlatformSealingKey.EnvVar]: path }), (error: unknown) =>
                error instanceof SealingKeyFileError && error.message.startsWith(PlatformSealingKey.EnvVar) && !error.message.includes('PRIVATE'))
        })
    })
})
