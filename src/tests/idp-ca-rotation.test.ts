import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EnvServerSeedSource, IdpDatabaseSecret, IngressTlsSource, K8sManifestBuilder } from '@pragmatic-tech-ai/pragmatic-tenant-plane'
import { KubectlError, type IInstallClock } from '@pragmatic-tech-ai/pragmatic-kube'
import { IdpCaRotation } from '../idp-ca-rotation.js'
import { InClusterIdpSeedSource } from '../in-cluster-idp-seed.js'
import { ConsoleInstallState, ConsoleInstallStep } from '../tenant-console-installer.js'
import { ConsoleInstallFixture } from './console-install-fakes.js'
import { LegacyDevCa } from './legacy-dev-ca.js'

type SecretDoc = { kind?: string; metadata?: { name?: string; namespace?: string; labels?: Record<string, string> }; data?: Record<string, string>; items?: SecretDoc[] }

/** PEM helpers for the assertions. */
class Pem
{
    public static Certificates(pem: string | Buffer): string[]
    {
        return pem.toString().match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? []
    }

    public static Same(a: string | Buffer, b: string | Buffer): boolean
    {
        return a.toString().replace(/\s+/g, '') === b.toString().replace(/\s+/g, '')
    }

    /** Whether `bundle` holds exactly `expected`, in order. */
    public static Is(bundle: string | Buffer, expected: Array<string | Buffer>): boolean
    {
        const held = Pem.Certificates(bundle)
        return held.length === expected.length && held.every((c, i) => Pem.Same(c, expected[i] as string | Buffer))
    }
}

/** A clock whose waits are logged into the cluster's call log, and that can run a step while it waits (a deploy meanwhile). */
class LoggedClock implements IInstallClock
{
    public readonly Delays: number[] = []
    public During: (() => void) | undefined

    public constructor(private readonly calls: string[][])
    {
    }

    public Now(): number
    {
        return 0
    }

    public async Delay(ms: number): Promise<void>
    {
        this.Delays.push(ms)
        this.calls.push(['Delay', String(ms)])
        this.During?.()
    }
}

/** A hive h1 (tenant acme) whose IdP was minted before pragmatic-shared 0.18.14, with environments that trust its CA. */
class RotationFixture
{
    public static readonly Env = 'dev'
    public static readonly StoppedEnv = 'qa'
    public static readonly Token = ConsoleInstallFixture.RunningIdpToken
    public readonly IdpNs = K8sManifestBuilder.IdpNameOf('acme')
    public readonly TlsName = InClusterIdpSeedSource.TlsSecretNameOf('acme')
    public readonly ConsoleCopy = K8sManifestBuilder.TenantConsoleIdpCaSecretNameOf('acme')
    public readonly LegacyCa: Buffer
    public readonly LegacyCert: Buffer
    public readonly LegacyKey: Buffer
    /** An unrelated CA an environment may trust too (another issuer than the IdP). */
    public readonly OtherCa: Buffer
    private readonly dir: string

    private constructor(public readonly Fx: ConsoleInstallFixture)
    {
        this.dir = mkdtempSync(join(tmpdir(), 'idp-ca-rotation-'))
        const files = LegacyDevCa.MintAt(this.dir, InClusterIdpSeedSource.HostOf('acme', ConsoleInstallFixture.BaseDomain)[0] as string)
        this.LegacyCa = readFileSync(files.caFile)
        this.LegacyCert = readFileSync(files.certFile)
        this.LegacyKey = readFileSync(files.keyFile)
        const other = mkdtempSync(join(this.dir, 'other-'))
        this.OtherCa = readFileSync(LegacyDevCa.MintAt(other, 'other.example', '/CN=another-ca').caFile)
        Fx.Kubectl.StoreAppliedSecrets = true
    }

    public static async Create(options: { environments?: boolean; consoleCopy?: boolean } = {}): Promise<RotationFixture>
    {
        const rf = new RotationFixture(await ConsoleInstallFixture.Create())
        rf.SeedIdp(rf.LegacyCa, rf.LegacyCert, rf.LegacyKey)
        // The realm's database Secret an earlier install minted (the rotation never touches it).
        rf.Fx.Kubectl.Put(rf.IdpNs, 'secret/' + IdpDatabaseSecret.NameOf('acme'), { kind: 'Secret', data: Object.fromEntries(
            [IdpDatabaseSecret.SuperuserKey, IdpDatabaseSecret.PasswordKey, IdpDatabaseSecret.UrlKey].map(k => [k, Buffer.from('db-' + k).toString('base64')])) })
        rf.Fx.Kubectl.Put(rf.IdpNs, 'deployment/' + rf.IdpNs, { kind: 'Deployment', metadata: { name: rf.IdpNs, namespace: rf.IdpNs } })
        if (options.environments ?? true)
        {
            rf.AddEnvironment(RotationFixture.Env, rf.LegacyCa, true)
            rf.AddEnvironment(RotationFixture.StoppedEnv, rf.LegacyCa, false)
        }
        if (options.consoleCopy ?? true)
        {
            rf.SetConsoleCopy(rf.LegacyCa)
        }
        return rf
    }

    public SeedIdp(ca: Buffer, cert: Buffer, key: Buffer): void
    {
        this.Fx.Kubectl.Put(this.IdpNs, 'secret/' + this.TlsName, { kind: 'Secret', data: { 'ca.crt': ca.toString('base64'), 'server.crt': cert.toString('base64'), 'server.key': key.toString('base64') } })
    }

    /** A current IdP TLS Secret (minted as 0.18.14 does); answers its CA. */
    public SeedCurrentIdp(): Buffer
    {
        const current = new InClusterIdpSeedSource(undefined, ConsoleInstallFixture.BaseDomain)
        const ca = current.SeedFor('acme').ca
        const data = (JSON.parse(current.TlsSecretManifestFor('acme')) as SecretDoc).items?.[0]?.data ?? {}
        this.SeedIdp(ca, Buffer.from(data['server.crt'] ?? '', 'base64'), Buffer.from(data['server.key'] ?? '', 'base64'))
        return ca
    }

    public SetConsoleCopy(ca: Buffer): void
    {
        this.Fx.Kubectl.Put(K8sManifestBuilder.SystemNamespace, 'secret/' + this.ConsoleCopy, {
            kind: 'Secret', type: 'Opaque', metadata: { name: this.ConsoleCopy, namespace: K8sManifestBuilder.SystemNamespace, labels: K8sManifestBuilder.HiveLabelsOf('h1') },
            data: { 'ca.crt': ca.toString('base64') },
        })
    }

    /** An environment namespace of hive h1 with its `<env>-idp-ca` Secret holding `ca`, and (when `server`) its server Deployment. */
    public AddEnvironment(name: string, ca: Buffer, server: boolean): void
    {
        const ns = K8sManifestBuilder.NamespaceOf(name)
        this.Fx.Kubectl.Namespaces.set(ns, K8sManifestBuilder.HiveLabelsOf('h1'))
        this.Fx.Kubectl.Put(ns, 'secret/' + EnvServerSeedSource.IdpCaSecretNameOf(name), { kind: 'Secret', data: { 'ca.crt': ca.toString('base64') } })
        if (server)
        {
            this.Fx.Kubectl.Put(ns, 'deployment/' + K8sManifestBuilder.ServerDeploymentOf(name), { kind: 'Deployment' })
        }
    }

    /** The IdP TLS Secret's data as the cluster holds it now. */
    public IdpTls(): Record<string, string>
    {
        return (JSON.parse(this.Fx.Kubectl.Objects.get(this.IdpNs + '|secret/' + this.TlsName) as string) as SecretDoc).data ?? {}
    }

    /** The CA PEM an environment's `<env>-idp-ca` Secret holds now. */
    public EnvTrust(name: string): string
    {
        const doc = JSON.parse(this.Fx.Kubectl.Objects.get(K8sManifestBuilder.NamespaceOf(name) + '|secret/' + EnvServerSeedSource.IdpCaSecretNameOf(name)) as string) as SecretDoc
        return Buffer.from(doc.data?.['ca.crt'] ?? '', 'base64').toString()
    }

    /** The CA PEM of every client-side apply of an environment's `<env>-idp-ca` Secret, in order. */
    public EnvTrustWrites(name: string): string[]
    {
        return this.Fx.Kubectl.Applied
            .map(m => JSON.parse(m) as SecretDoc)
            .filter(d => d.kind === 'Secret' && d.metadata?.name === EnvServerSeedSource.IdpCaSecretNameOf(name))
            .map(d => Buffer.from(d.data?.['ca.crt'] ?? '', 'base64').toString('utf8'))
    }

    /** The console's IdP CA copy as the cluster holds it now. */
    public ConsoleTrust(): string
    {
        const doc = JSON.parse(this.Fx.Kubectl.Objects.get(K8sManifestBuilder.SystemNamespace + '|secret/' + this.ConsoleCopy) as string) as SecretDoc
        return Buffer.from(doc.data?.['ca.crt'] ?? '', 'base64').toString()
    }

    /** Every server-side apply naming the console's IdP CA copy, as the items written. */
    public ConsoleCopyWrites(): SecretDoc[]
    {
        return this.Fx.Kubectl.ServerApplied.flatMap(m => { const d = JSON.parse(m) as SecretDoc; return d.kind === 'List' ? d.items ?? [] : [d] })
            .filter(d => d.kind === 'Secret' && d.metadata?.name === this.ConsoleCopy)
    }

    /** How many calls of a verb reached one namespace. */
    public Count(verb: string, namespace: string): number
    {
        return this.Fx.Kubectl.Calls.filter(c => c[0] === verb && c[1] === namespace).length
    }

    /** The index in the call log of the first call matching. */
    public IndexOf(match: (call: string[]) => boolean): number
    {
        return this.Fx.Kubectl.Calls.findIndex(match)
    }

    public Rotation(clock: IInstallClock = new LoggedClock(this.Fx.Kubectl.Calls), scrub: string[] = []): IdpCaRotation
    {
        return new IdpCaRotation(this.Fx.Kubectl, clock, scrub)
    }

    public async Install(): Promise<{ state?: ConsoleInstallState; step?: ConsoleInstallStep; error?: string }>
    {
        this.Fx.Installer.Start('h1')
        return await this.Fx.Installer.WhenSettled('h1') ?? {}
    }

    public Dispose(): void
    {
        this.Fx.Dispose()
        rmSync(this.dir, { recursive: true, force: true })
    }
}

describe('IdpCaRotation', () =>
{
    let rf: RotationFixture | undefined

    afterEach(() =>
    {
        rf?.Dispose()
        rf = undefined
    })

    it('judges a CA from the certificate: one minted before 0.18.14 is legacy, a current DevCa CA is not, an unparsable one is not judged', async () =>
    {
        rf = await RotationFixture.Create()
        const current = new InClusterIdpSeedSource(undefined, ConsoleInstallFixture.BaseDomain).SeedFor('acme').ca
        assert.equal(IdpCaRotation.IsLegacy(rf.LegacyCa), true)
        assert.equal(IdpCaRotation.IsLegacy(current), false)
        assert.equal(IdpCaRotation.IsLegacy(Buffer.from(ConsoleInstallFixture.RunningIdpCa)), false)
        // A bundle is judged by its first certificate (the one a rotation puts first is the new CA).
        assert.equal(IdpCaRotation.IsLegacy(Buffer.concat([current, rf.LegacyCa])), false)
    })

    it('renews a pre-0.18.14 CA in one watched install: copies trust old and new, servers restart, the IdP moves, then the copies narrow', async () =>
    {
        rf = await RotationFixture.Create()
        const fx = rf.Fx
        const settled = await rf.Install()
        assert.equal(settled.state, ConsoleInstallState.Deployed, settled.error)

        // The IdP serves a new, current CA and a new leaf; its key is new too.
        const tls = rf.IdpTls()
        const newCa = Buffer.from(tls['ca.crt'] as string, 'base64')
        assert.equal(IdpCaRotation.IsLegacy(newCa), false)
        assert.ok(!Pem.Same(newCa, rf.LegacyCa))
        assert.notEqual(tls['server.key'], rf.LegacyKey.toString('base64'))

        // The running environment's copy: first new + old (the transition bundle), then the new CA alone.
        const writes = rf.EnvTrustWrites(RotationFixture.Env)
        assert.equal(writes.length, 2)
        assert.ok(Pem.Is(writes[0] as string, [newCa, rf.LegacyCa]))
        assert.ok(Pem.Is(writes[1] as string, [newCa]))
        // A stopped environment (no server Deployment) has its copy moved the same way, and nothing restarted.
        assert.ok(Pem.Is(rf.EnvTrust(RotationFixture.StoppedEnv), [newCa]))
        assert.equal(rf.Count('RolloutRestart', K8sManifestBuilder.NamespaceOf(RotationFixture.StoppedEnv)), 0)
        assert.equal(rf.Count('RolloutRestart', K8sManifestBuilder.NamespaceOf(RotationFixture.Env)), 1)

        // The console's own copy trusts both during the switch, rendered as the bootstrap renders it (the hive's label).
        const copy = rf.ConsoleCopyWrites()[0]
        assert.ok(Pem.Is(Buffer.from(copy?.data?.['ca.crt'] ?? '', 'base64'), [newCa, rf.LegacyCa]))
        assert.deepEqual(copy?.metadata?.labels, K8sManifestBuilder.HiveLabelsOf('h1'))
        assert.ok(Pem.Is(rf.ConsoleTrust(), [newCa]))

        // Sealed with the IdP's unchanged admin token; the rest of the install carries the new CA too.
        assert.ok(fx.IdpAdmin.Remembered.length >= 2)
        for (const r of fx.IdpAdmin.Remembered)
        {
            assert.equal(r.adminToken, RotationFixture.Token)
            assert.ok(Pem.Same(r.ca, newCa))
        }
        // The admin token Secret and the IdP's database Secret are never written.
        const kept = [InClusterIdpSeedSource.AdminSecretNameOf('acme'), IdpDatabaseSecret.NameOf('acme')]
        const secrets = [...fx.Kubectl.ServerApplied, ...fx.Kubectl.Applied]
            .flatMap(m => { const d = JSON.parse(m) as SecretDoc; return d.kind === 'List' ? d.items ?? [] : [d] })
            .filter(d => d.kind === 'Secret' && d.metadata?.namespace === rf!.IdpNs)
        assert.ok(secrets.length > 0)
        assert.ok(secrets.every(d => !kept.includes(d.metadata?.name ?? '')))
    })

    it('orders the switch: copies widened, the kubelet given its sync, then servers restarted and awaited, then the IdP', async () =>
    {
        rf = await RotationFixture.Create()
        const clock = new LoggedClock(rf.Fx.Kubectl.Calls)
        const rotated = await rf.Rotation(clock).Rotate('h1', 'acme', ConsoleInstallFixture.BaseDomain)
        assert.deepEqual(rotated?.Restarted, [RotationFixture.Env])
        assert.deepEqual(clock.Delays, [IdpCaRotation.SecretSyncMs])
        assert.ok(IdpCaRotation.SecretSyncMs >= 60_000, "at least the kubelet's default sync period")
        const envNs = K8sManifestBuilder.NamespaceOf(RotationFixture.Env)
        const consoleWrite = rf.IndexOf(c => c[0] === 'ApplyServerSide')
        const delay = rf.IndexOf(c => c[0] === 'Delay')
        const envRestart = rf.IndexOf(c => c[0] === 'RolloutRestart' && c[1] === envNs)
        const envWait = rf.IndexOf(c => c[0] === 'RolloutStatus' && c[1] === envNs)
        const tlsWrite = rf.Fx.Kubectl.Calls.findIndex((c, i) => c[0] === 'ApplyServerSide' && i > consoleWrite)
        const idpRestart = rf.IndexOf(c => c[0] === 'RolloutRestart' && c[1] === rf!.IdpNs)
        assert.ok(consoleWrite >= 0 && consoleWrite < delay)
        assert.ok(delay < envRestart && envRestart < envWait && envWait < tlsWrite && tlsWrite < idpRestart)
        // Rotate leaves the copies wide: narrowing waits for the caller to seal the new CA.
        assert.equal(Pem.Certificates(rf.EnvTrust(RotationFixture.Env)).length, 2)
    })

    it('widens and restarts an environment the console deployed during the wait, and one it rewrote with the old CA alone', async () =>
    {
        rf = await RotationFixture.Create()
        const clock = new LoggedClock(rf.Fx.Kubectl.Calls)
        const fixture = rf
        clock.During = () =>
        {
            fixture.AddEnvironment('late', fixture.LegacyCa, true)
            fixture.AddEnvironment(RotationFixture.Env, fixture.LegacyCa, true)
        }
        const rotated = await rf.Rotation(clock).Rotate('h1', 'acme', ConsoleInstallFixture.BaseDomain)
        const newCa = Buffer.from(rf.IdpTls()['ca.crt'] as string, 'base64')
        assert.deepEqual([...rotated?.Restarted ?? []].sort(), [RotationFixture.Env, 'late'])
        for (const env of [RotationFixture.Env, 'late'])
        {
            assert.ok(Pem.Is(rf.EnvTrust(env), [newCa, rf.LegacyCa]), env)
            const restart = rf.IndexOf(c => c[0] === 'RolloutRestart' && c[1] === K8sManifestBuilder.NamespaceOf(env))
            assert.ok(restart > rf.IndexOf(c => c[0] === 'Delay'), env)
        }
    })

    it('leaves a copy that does not trust the IdP alone, and keeps any other CA a copy trusts', async () =>
    {
        rf = await RotationFixture.Create({ environments: false })
        rf.AddEnvironment('foreign', rf.OtherCa, true)
        rf.AddEnvironment('mixed', Buffer.concat([rf.LegacyCa, rf.OtherCa]), true)
        assert.equal((await rf.Install()).state, ConsoleInstallState.Deployed)
        const newCa = Buffer.from(rf.IdpTls()['ca.crt'] as string, 'base64')
        assert.equal(rf.EnvTrustWrites('foreign').length, 0)
        assert.equal(rf.Count('RolloutRestart', K8sManifestBuilder.NamespaceOf('foreign')), 0)
        assert.ok(Pem.Is(rf.EnvTrustWrites('mixed')[0] as string, [newCa, rf.LegacyCa, rf.OtherCa]))
        assert.ok(Pem.Is(rf.EnvTrust('mixed'), [newCa, rf.OtherCa]))
    })

    it('is idempotent: a second install with a now-current CA renews nothing, restarts and writes nothing', async () =>
    {
        rf = await RotationFixture.Create()
        assert.equal((await rf.Install()).state, ConsoleInstallState.Deployed)
        const tls = rf.IdpTls()
        const envNs = K8sManifestBuilder.NamespaceOf(RotationFixture.Env)
        const writesBefore = rf.EnvTrustWrites(RotationFixture.Env).length
        const idpRestartsBefore = rf.Count('RolloutRestart', rf.IdpNs)
        assert.equal((await rf.Install()).state, ConsoleInstallState.Deployed)
        assert.deepEqual(rf.IdpTls(), tls)
        assert.equal(rf.Count('RolloutRestart', envNs), 1)
        assert.equal(rf.EnvTrustWrites(RotationFixture.Env).length, writesBefore)
        // The first install restarted the IdP once for the renewal plus what its own roll does; the second only the roll.
        assert.equal(rf.Count('RolloutRestart', rf.IdpNs) - idpRestartsBefore, idpRestartsBefore - 1)
    })

    it('does nothing for a CA it cannot parse, or without the admin token Secret', async () =>
    {
        const plain = await ConsoleInstallFixture.Create()
        try
        {
            const ns = K8sManifestBuilder.NamespaceOf('dev')
            plain.Kubectl.Namespaces.set(ns, K8sManifestBuilder.HiveLabelsOf('h1'))
            plain.Kubectl.Put(ns, 'secret/' + EnvServerSeedSource.IdpCaSecretNameOf('dev'), { kind: 'Secret', data: { 'ca.crt': Buffer.from(ConsoleInstallFixture.RunningIdpCa).toString('base64') } })
            plain.Kubectl.Put(ns, 'deployment/' + K8sManifestBuilder.ServerDeploymentOf('dev'), { kind: 'Deployment' })
            plain.Installer.Start('h1')
            assert.equal((await plain.Installer.WhenSettled('h1'))?.state, ConsoleInstallState.Deployed)
            assert.equal(plain.Kubectl.Calls.filter(c => c[0] === 'RolloutRestart' && c[1] === ns).length, 0)
            assert.equal(plain.Kubectl.Applied.filter(m => m.includes(EnvServerSeedSource.IdpCaSecretNameOf('dev'))).length, 0)
        }
        finally
        {
            plain.Dispose()
        }
        rf = await RotationFixture.Create()
        rf.Fx.Kubectl.Objects.delete(rf.IdpNs + '|secret/' + InClusterIdpSeedSource.AdminSecretNameOf('acme'))
        await rf.Install()
        assert.equal(rf.EnvTrustWrites(RotationFixture.Env).length, 0)
        assert.equal(rf.Count('RolloutRestart', K8sManifestBuilder.NamespaceOf(RotationFixture.Env)), 0)
    })

    it('does not renew for an install its certificates step would refuse anyway (no trust root, an unusable TLS Secret, an incomplete database Secret)', async () =>
    {
        rf = await RotationFixture.Create()
        rf.Fx.Hives.set('h1', { ...ConsoleInstallFixture.Hive('h1'), trustRootRef: undefined })
        const noRoot = await rf.Install()
        assert.equal(noRoot.state, ConsoleInstallState.Failed)
        assert.equal(noRoot.step, ConsoleInstallStep.PreparingCertificates)
        assert.equal(rf.Count('RolloutRestart', K8sManifestBuilder.NamespaceOf(RotationFixture.Env)), 0)
        assert.equal(rf.IdpTls()['ca.crt'], rf.LegacyCa.toString('base64'))

        rf.Fx.Hives.set('h1', { ...ConsoleInstallFixture.Hive('h1'), console: { baseDomain: ConsoleInstallFixture.BaseDomain, tls: { source: IngressTlsSource.ExistingSecret, secretName: 'missing-tls' } } })
        const noTls = await rf.Install()
        assert.equal(noTls.step, ConsoleInstallStep.PreparingCertificates)
        assert.equal(rf.EnvTrustWrites(RotationFixture.Env).length, 0)

        rf.Fx.Hives.set('h1', ConsoleInstallFixture.Hive('h1'))
        rf.Fx.Kubectl.Put(rf.IdpNs, 'secret/' + IdpDatabaseSecret.NameOf('acme'), { kind: 'Secret', data: { [IdpDatabaseSecret.SuperuserKey]: 'eA==' } })
        const noDatabase = await rf.Install()
        assert.equal(noDatabase.state, ConsoleInstallState.Failed)
        assert.equal(noDatabase.step, ConsoleInstallStep.PreparingCertificates)
        assert.equal(rf.EnvTrustWrites(RotationFixture.Env).length, 0)
    })

    it('an environment that fails to restart: everything is put back, the IdP is untouched, and the install stops at its own step', async () =>
    {
        rf = await RotationFixture.Create()
        const fx = rf.Fx
        const envNs = K8sManifestBuilder.NamespaceOf(RotationFixture.Env)
        fx.Kubectl.RolloutStatusFailures.set(envNs, [true])
        const settled = await rf.Install()
        assert.equal(settled.state, ConsoleInstallState.Failed)
        assert.equal(settled.step, ConsoleInstallStep.RotatingIdpCa)
        assert.match(settled.error ?? '', /predates pragmatic-shared 0\.18\.14/)
        assert.match(settled.error ?? '', /environment dev did not restart trusting the new certificate authority/)
        assert.match(settled.error ?? '', /were put back/)
        // The IdP kept its TLS Secret and was never restarted; nothing was sealed and nothing of the console applied.
        assert.deepEqual(rf.IdpTls(), { 'ca.crt': rf.LegacyCa.toString('base64'), 'server.crt': rf.LegacyCert.toString('base64'), 'server.key': rf.LegacyKey.toString('base64') })
        assert.equal(rf.Count('RolloutRestart', rf.IdpNs), 0)
        assert.deepEqual(fx.IdpAdmin.Remembered, [])
        assert.equal(fx.Kubectl.Applied.filter(m => m.includes('Deployment')).length, 0)
        // Each environment's copy and the console's are back to exactly their previous CA; the failed server restarted once more.
        assert.ok(Pem.Is(rf.EnvTrust(RotationFixture.Env), [rf.LegacyCa]))
        assert.ok(Pem.Is(rf.EnvTrust(RotationFixture.StoppedEnv), [rf.LegacyCa]))
        assert.ok(Pem.Is(rf.ConsoleTrust(), [rf.LegacyCa]))
        assert.equal(rf.Count('RolloutRestart', envNs), 2)
    })

    it('an IdP that fails to restart on its new certificate: the previous TLS Secret is put back and the IdP restarted onto it', async () =>
    {
        rf = await RotationFixture.Create()
        const fx = rf.Fx
        fx.Kubectl.RolloutStatusFailures.set(rf.IdpNs, [true])
        const settled = await rf.Install()
        assert.equal(settled.state, ConsoleInstallState.Failed)
        assert.equal(settled.step, ConsoleInstallStep.RotatingIdpCa)
        assert.match(settled.error ?? '', /the identity provider did not restart on its new certificate/)
        assert.match(settled.error ?? '', /were put back, and the identity provider and the environments trust them again/)
        assert.deepEqual(rf.IdpTls(), { 'ca.crt': rf.LegacyCa.toString('base64'), 'server.crt': rf.LegacyCert.toString('base64'), 'server.key': rf.LegacyKey.toString('base64') })
        assert.equal(rf.Count('RolloutRestart', rf.IdpNs), 2)
        assert.ok(Pem.Is(rf.EnvTrust(RotationFixture.Env), [rf.LegacyCa]))
        // The environment restarted with new + old trust keeps running: it trusts the old CA too, so it is not restarted again.
        assert.equal(rf.Count('RolloutRestart', K8sManifestBuilder.NamespaceOf(RotationFixture.Env)), 1)
        assert.deepEqual(fx.IdpAdmin.Remembered, [])
    })

    it('never shows a server key, old or new, even in kubectl text that carries one', async () =>
    {
        rf = await RotationFixture.Create()
        const fx = rf.Fx
        const fixture = rf
        fx.Kubectl.RolloutStatusErrors.set(rf.IdpNs, () =>
        {
            const fresh = fixture.IdpTls()['server.key'] ?? ''
            const text = 'leaked ' + fresh + ' ' + Buffer.from(fresh, 'base64').toString() + ' ' + fixture.LegacyKey.toString('base64') + ' ' + fixture.LegacyKey.toString()
            return new KubectlError(text, '', false)
        })
        const settled = await rf.Install()
        assert.equal(settled.state, ConsoleInstallState.Failed)
        assert.match(settled.error ?? '', /leaked/)
        const fresh = JSON.parse(fx.Kubectl.ServerApplied.find(m => m.includes(rf!.TlsName)) as string) as SecretDoc
        const freshKey = fresh.items?.[0]?.data?.['server.key'] ?? ''
        for (const key of [freshKey, rf.LegacyKey.toString('base64')])
        {
            assert.ok(key.length > 0)
            assert.ok(!(settled.error ?? '').includes(key))
            for (const line of Buffer.from(key, 'base64').toString().split('\n').filter(l => l.length > 20 && !l.startsWith('-----')))
            {
                assert.ok(!(settled.error ?? '').includes(line))
            }
        }
    })

    it('names what is not ready after the put-back, and every refused put-back while still putting back the rest', async () =>
    {
        rf = await RotationFixture.Create()
        rf.Fx.Kubectl.RolloutStatusFailures.set(rf.IdpNs, [true, true])
        const pending = await rf.Install()
        assert.match(pending.error ?? '', /not ready yet \(check them in the cluster\): the identity provider\./)
        rf.Dispose()

        rf = await RotationFixture.Create({ consoleCopy: false })
        rf.Fx.Kubectl.RolloutStatusFailures.set(rf.IdpNs, [true])
        // Server-side applies: 0 the new TLS Secret, 1 its put-back (refused).
        rf.Fx.Kubectl.ServerApplyFail = { at: 1, error: async () => new KubectlError('the server refused the put-back') }
        const refused = await rf.Install()
        assert.equal(refused.state, ConsoleInstallState.Failed)
        assert.match(refused.error ?? '', /Putting the previous certificate authority back was refused for the identity provider/)
        assert.match(refused.error ?? '', /the server refused the put-back/)
        // The environments' copies were still put back.
        assert.ok(Pem.Is(rf.EnvTrust(RotationFixture.Env), [rf.LegacyCa]))
        assert.ok(Pem.Is(rf.EnvTrust(RotationFixture.StoppedEnv), [rf.LegacyCa]))
    })

    it('a refused change while widening the trust is put back too', async () =>
    {
        rf = await RotationFixture.Create()
        // Client-side applies: 0 dev's bundle, 1 qa's bundle (refused).
        rf.Fx.Kubectl.ApplyFailures.add(1)
        const settled = await rf.Install()
        assert.equal(settled.state, ConsoleInstallState.Failed)
        assert.match(settled.error ?? '', /the cluster refused a change\. kubectl failed: apply refused/)
        assert.match(settled.error ?? '', /were put back/)
        assert.equal(rf.IdpTls()['ca.crt'], rf.LegacyCa.toString('base64'))
        assert.ok(Pem.Is(rf.EnvTrust(RotationFixture.Env), [rf.LegacyCa]))
        assert.ok(Pem.Is(rf.ConsoleTrust(), [rf.LegacyCa]))
    })

    it('a console copy without a CA is neither widened nor written back', async () =>
    {
        rf = await RotationFixture.Create({ consoleCopy: false })
        rf.Fx.Kubectl.Put(K8sManifestBuilder.SystemNamespace, 'secret/' + rf.ConsoleCopy, { kind: 'Secret', metadata: { name: rf.ConsoleCopy, namespace: K8sManifestBuilder.SystemNamespace }, data: {} })
        rf.Fx.Kubectl.RolloutStatusFailures.set(rf.IdpNs, [true])
        await rf.Install()
        assert.deepEqual(rf.ConsoleCopyWrites(), [])
    })

    it('a current CA that a copy still trusts beside the old one: an interrupted renewal, so the IdP restarts and is awaited before the copies narrow', async () =>
    {
        rf = await RotationFixture.Create({ environments: false, consoleCopy: false })
        const ca = rf.SeedCurrentIdp()
        rf.AddEnvironment(RotationFixture.Env, Buffer.concat([ca, rf.LegacyCa]), true)
        const rotation = rf.Rotation()
        assert.equal(await rotation.Rotate('h1', 'acme', ConsoleInstallFixture.BaseDomain), undefined)
        assert.equal(rf.Count('RolloutRestart', rf.IdpNs), 1)
        assert.equal(rf.Count('RolloutStatus', rf.IdpNs), 1)
        assert.equal(rf.Count('RolloutRestart', K8sManifestBuilder.NamespaceOf(RotationFixture.Env)), 0)
        await rotation.Narrow('h1', 'acme')
        assert.ok(Pem.Is(rf.EnvTrust(RotationFixture.Env), [ca]))

        // The same with only the console's copy left wide (a hive without environments).
        rf.SetConsoleCopy(Buffer.concat([ca, rf.LegacyCa]))
        await rf.Rotation().Rotate('h1', 'acme', ConsoleInstallFixture.BaseDomain)
        assert.equal(rf.Count('RolloutRestart', rf.IdpNs), 2)

        // That restart not finishing stops the install, naming it; nothing narrows.
        rf.Fx.Kubectl.RolloutStatusFailures.set(rf.IdpNs, [true])
        const settled = await rf.Install()
        assert.equal(settled.state, ConsoleInstallState.Failed)
        assert.equal(settled.step, ConsoleInstallStep.RotatingIdpCa)
        assert.match(settled.error ?? '', /an earlier renewal may not have restarted the identity provider/)
        assert.ok(Pem.Is(rf.ConsoleTrust(), [ca, rf.LegacyCa]))
    })

    it('a current CA with narrow copies restarts nothing', async () =>
    {
        rf = await RotationFixture.Create({ environments: false, consoleCopy: false })
        const ca = rf.SeedCurrentIdp()
        rf.AddEnvironment(RotationFixture.Env, ca, true)
        rf.SetConsoleCopy(ca)
        const rotation = rf.Rotation()
        assert.equal(await rotation.Rotate('h1', 'acme', ConsoleInstallFixture.BaseDomain), undefined)
        await rotation.Narrow('h1', 'acme')
        assert.equal(rf.Count('RolloutRestart', rf.IdpNs), 0)
        assert.deepEqual(rf.EnvTrustWrites(RotationFixture.Env), [])
        assert.deepEqual(rf.ConsoleCopyWrites(), [])
    })

    it('a failed narrowing after the switch does not fail the install: the new CA is sealed and the next install narrows', async () =>
    {
        rf = await RotationFixture.Create({ environments: false })
        rf.AddEnvironment(RotationFixture.Env, rf.LegacyCa, true)
        // Client-side applies: 0 dev's bundle, 1 dev's narrowing (refused).
        rf.Fx.Kubectl.ApplyFailures.add(1)
        const settled = await rf.Install()
        assert.equal(settled.state, ConsoleInstallState.Deployed, settled.error)
        const newCa = Buffer.from(rf.IdpTls()['ca.crt'] as string, 'base64')
        assert.ok(Pem.Same(rf.Fx.IdpAdmin.Remembered[0]?.ca ?? '', newCa))
        assert.ok(Pem.Is(rf.EnvTrust(RotationFixture.Env), [newCa, rf.LegacyCa]))
        assert.equal((await rf.Install()).state, ConsoleInstallState.Deployed)
        assert.ok(Pem.Is(rf.EnvTrust(RotationFixture.Env), [newCa]))
    })

    it('a seal that fails after the switch says the CA was renewed', async () =>
    {
        rf = await RotationFixture.Create()
        rf.Fx.IdpAdmin.Remember = async () => { throw new Error('sealed store unwritable') }
        const settled = await rf.Install()
        assert.equal(settled.state, ConsoleInstallState.Failed)
        assert.equal(settled.step, ConsoleInstallStep.RotatingIdpCa)
        assert.match(settled.error ?? '', /was renewed and the identity provider runs on it, but the control plane could not seal the new one/)
        assert.equal(IdpCaRotation.IsLegacy(Buffer.from(rf.IdpTls()['ca.crt'] as string, 'base64')), false)
    })

    it('keeps a current CA of another DevCa issuer in a copy, dropping only the IdP CA it replaced', async () =>
    {
        rf = await RotationFixture.Create({ environments: false })
        const another = new InClusterIdpSeedSource(undefined, ConsoleInstallFixture.BaseDomain).SeedFor('another').ca
        rf.AddEnvironment(RotationFixture.Env, Buffer.concat([rf.LegacyCa, another]), true)
        assert.equal((await rf.Install()).state, ConsoleInstallState.Deployed)
        const newCa = Buffer.from(rf.IdpTls()['ca.crt'] as string, 'base64')
        assert.ok(Pem.Is(rf.EnvTrust(RotationFixture.Env), [newCa, another]))
    })

    it('hands both forms of the old and the new server key to the scrub list', async () =>
    {
        rf = await RotationFixture.Create()
        const scrub: string[] = []
        await rf.Rotation(undefined, scrub).Rotate('h1', 'acme', ConsoleInstallFixture.BaseDomain)
        const freshKey = rf.IdpTls()['server.key'] as string
        for (const key of [rf.LegacyKey.toString('base64'), freshKey])
        {
            assert.ok(scrub.includes(key))
            assert.ok(scrub.includes(Buffer.from(key, 'base64').toString().trim()))
        }
    })

    it('seals the current CA when it finished an interrupted renewal, before the rest of the install', async () =>
    {
        rf = await RotationFixture.Create({ environments: false, consoleCopy: false })
        const ca = rf.SeedCurrentIdp()
        rf.SetConsoleCopy(Buffer.concat([ca, rf.LegacyCa]))
        assert.equal((await rf.Install()).state, ConsoleInstallState.Deployed)
        const calls = rf.Fx.Kubectl.Calls
        const sealed = calls.findIndex(c => c[0] === 'Remember')
        const applied = calls.findIndex(c => c[0] === 'Apply')
        assert.ok(sealed >= 0 && sealed < applied)
        assert.ok(Pem.Same(rf.Fx.IdpAdmin.Remembered[0]?.ca ?? '', ca))
    })

    it("a current CA with nothing interrupted is sealed only by the install's own step", async () =>
    {
        rf = await RotationFixture.Create({ environments: false, consoleCopy: false })
        rf.SeedCurrentIdp()
        assert.equal((await rf.Install()).state, ConsoleInstallState.Deployed)
        const calls = rf.Fx.Kubectl.Calls
        assert.ok(calls.findIndex(c => c[0] === 'Remember') > calls.findIndex(c => c[0] === 'Apply'))
    })

    it('logs a failed seal by the error name', async () =>
    {
        rf = await RotationFixture.Create()
        rf.Fx.IdpAdmin.Remember = async () => { throw new RangeError('sealed store unwritable') }
        const lines: string[] = []
        const original = console.error
        console.error = (...args: unknown[]) => { lines.push(args.map(a => String(a)).join(' ')) }
        try
        {
            await rf.Install()
        }
        finally
        {
            console.error = original
        }
        assert.ok(lines.some(l => l.includes('sealing the renewed identity provider certificate authority failed: RangeError')))
        assert.ok(!lines.some(l => l.includes('sealed store unwritable')))
    })
})
