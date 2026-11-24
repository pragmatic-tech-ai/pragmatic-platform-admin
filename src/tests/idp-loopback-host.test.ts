import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DevCa } from '@pragmatic-tech-ai/pragmatic-identity-source-oidc'
import { IdpLoopbackHost } from '../idp-loopback-host.js'
import { LegacyDevCa } from './legacy-dev-ca.js'

class LoopbackFx
{
    public static readonly Host = 'host.docker.internal'
    public static readonly TempPrefix = 'idp-loopback-'
    public static readonly NotACertificate = 'CA PEM'

    public static InTemp(body: (dir: string) => void): void
    {
        const dir = mkdtempSync(join(tmpdir(), LoopbackFx.TempPrefix))
        try
        {
            body(dir)
        }
        finally
        {
            rmSync(dir, { recursive: true, force: true })
        }
    }
}

test('a DevCa CA of 0.18.14 or later is verified by localhost, an older one (permitted IP subtree) by 127.0.0.1', () =>
{
    LoopbackFx.InTemp(dir =>
    {
        const current = DevCa.EnsureAt(join(dir, 'current'), LoopbackFx.Host)
        const legacy = LegacyDevCa.MintAt(dir, LoopbackFx.Host)
        assert.equal(IdpLoopbackHost.For(readFileSync(current.caFile)), IdpLoopbackHost.Localhost)
        assert.equal(IdpLoopbackHost.For(readFileSync(legacy.caFile)), IdpLoopbackHost.LoopbackIp)
        assert.equal(IdpLoopbackHost.For(readFileSync(legacy.caFile).toString('utf8')), IdpLoopbackHost.LoopbackIp, 'a PEM string reads the same')
    })
})

test('a CA with no name constraints (DevCa before them) answers 127.0.0.1; one that does not parse answers localhost', () =>
{
    LoopbackFx.InTemp(dir =>
    {
        const ca = join(dir, 'plain-ca.crt')
        execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'plain-ca.key'), '-out', ca, '-days', '1', '-subj', '/CN=plain', '-addext', 'basicConstraints=critical,CA:TRUE'], { stdio: 'pipe' })
        assert.equal(IdpLoopbackHost.For(readFileSync(ca)), IdpLoopbackHost.LoopbackIp)
    })
    assert.equal(IdpLoopbackHost.For(LoopbackFx.NotACertificate), IdpLoopbackHost.Localhost)
})

test('malformed DER ends the walk instead of running past the buffer', () =>
{
    const oid = [0x06, 0x03, 0x55, 0x1d, 0x1e]
    assert.equal(IdpLoopbackHost.PermitsLocalhost(Buffer.from([0x30, 0x00])), false)
    assert.equal(IdpLoopbackHost.PermitsLocalhost(Buffer.from([...oid, 0x04, 0x84, 0x30, 0xff, 0xff, 0xff, 0xff])), false)
    assert.equal(IdpLoopbackHost.PermitsLocalhost(Buffer.from([...oid, 0x04, 0x06, 0x30, 0x04, 0xa0, 0xff, 0x30, 0x7f])), false)
    assert.equal(IdpLoopbackHost.PermitsLocalhost(Buffer.from([...oid, 0x04, 0x05, 0x30, 0x03, 0xa0, 0x89])), false)
})
