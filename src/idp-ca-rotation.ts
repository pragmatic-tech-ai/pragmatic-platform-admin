import { X509Certificate } from 'node:crypto'
import { EnvServerSeedSource, K8sManifestBuilder } from '@pragmatic-tech-ai/pragmatic-tenant-plane'
import { KubectlError, type IInstallClock, type IKubectl } from '@pragmatic-tech-ai/pragmatic-kube'
import { IdpLoopbackHost } from './idp-loopback-host.js'
import { IdpSecretSet, InClusterIdpSeedSource } from './in-cluster-idp-seed.js'
import { BootstrapSecretSet, TenantAdminBootstrap } from './tenant-admin-bootstrap.js'

/** An IdP CA rotation stopped. The message is a plain sentence plus kubectl's own (redacted) text; the installer scrubs it again. */
export class IdpCaRotationError extends Error
{
    private static readonly ErrorName = 'IdpCaRotationError'

    public constructor(message: string)
    {
        super(message)
        this.name = IdpCaRotationError.ErrorName
    }
}

/** What a rotation that ran did: the new CA, and the environments whose server it restarted. */
export class IdpCaRotated
{
    public constructor(public readonly Ca: Buffer, public readonly Restarted: readonly string[])
    {
    }
}

/** An environment of the hive whose server trusts the IdP through its `<env>-idp-ca` Secret, with what that Secret held. */
class TrustingEnvironment
{
    public constructor(public readonly Name: string, public readonly Namespace: string, public readonly Held: Buffer, public readonly HasServer: boolean)
    {
    }

    public get Deployment(): string
    {
        return K8sManifestBuilder.ServerDeploymentOf(this.Name)
    }
}

/** What one rotation changed so far, so a failure puts back exactly that. */
class RotationJournal
{
    /** Each environment whose copy was written, with what it held before the first write. */
    public readonly Trust: TrustingEnvironment[] = []
    public ConsoleTrust = false
    public IdpTls = false
    public FailedServer: TrustingEnvironment | undefined

    public Holds(name: string): boolean
    {
        return this.Trust.some(e => e.Name === name)
    }
}

/**
 * Renews an in-hive IdP's DevCa when it predates pragmatic-shared 0.18.14 (its CA carries an IP subtree or no name
 * constraints, which Electron's BoringSSL refuses; read from the certificate itself, IdpLoopbackHost). DevCa never keeps
 * its CA key, so the leaf cannot be re-issued under the old CA: a new CA and leaf are minted and every copy of the CA moves.
 * The order leaves no window in which a client verifies against the wrong CA (a transition bundle, new + old):
 *   1. the console's own copy and every environment's `<env>-idp-ca` Secret trust new + old; then SecretSyncMs passes,
 *      so the kubelet has refreshed the console's mounted copy (it reads it per call and deploys environments with it;
 *      never restarted here) and every cached copy; environments the console deployed meanwhile (new ones, or ones it
 *      rewrote with the copy it read before) are widened too;
 *   2. each environment's server restarts onto that (it reads its CA at start, NODE_EXTRA_CA_CERTS) and is awaited;
 *   3. the IdP's TLS Secret takes the new CA and leaf, and the IdP restarts and is awaited.
 * Then (Narrow, after the caller sealed the new CA) every copy drops the IdP's earlier CAs: no restart, since a running
 * server's new + old trust is a superset and the old CA's key no longer exists. On any failure in 1-3, what was changed
 * is put back (the previous TLS Secret and the IdP restarted onto it, every copy's previous content, and the one server
 * that did not restart restarted once more), and the install stops saying so. The admin token, the IdP's database and its
 * realm data are never touched. A crash converges on the next install: before 3 the old CA is still served and is renewed
 * again; after it the CA is current, and a copy still trusting an earlier IdP CA beside it is the sign of a rotation that
 * may not have restarted the IdP, so the IdP is restarted and awaited before anything narrows. Secret values go only to
 * kubectl.
 */
export class IdpCaRotation
{
    /**
     * How long the rotation waits for the kubelet to refresh mounted Secrets before anything restarts or the IdP moves:
     * the kubelet's default sync period (1 minute) plus its cache's, with margin. A kubelet configured with a longer
     * `syncFrequency` lengthens the console's window (it would verify the IdP against the old copy until its refresh).
     */
    public static readonly SecretSyncMs = 90_000

    private static readonly SecretPrefix = 'secret/'
    private static readonly DeploymentPrefix = 'deployment/'
    private static readonly CaKey = 'ca.crt'
    private static readonly ServerKeyKey = 'server.key'
    private static readonly Base64 = 'base64'
    private static readonly Utf8 = 'utf8'
    private static readonly Newline = '\n'
    private static readonly Space = ' '
    private static readonly ListSeparator = ', '
    private static readonly End = '.'
    private static readonly NoDetail = ''
    private static readonly CertificateBlock = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g
    private static readonly Whitespace = /\s+/g
    private static readonly StoppedPrefix = "The identity provider's certificate authority predates pragmatic-shared 0.18.14 (Plexus cannot verify it), and renewing it stopped: "
    private static readonly ServerNotRestartedPrefix = 'environment '
    private static readonly ServerNotRestartedSuffix = ' did not restart trusting the new certificate authority.'
    private static readonly IdpNotRestartedMessage = 'the identity provider did not restart on its new certificate.'
    private static readonly RefusedMessage = 'the cluster refused a change.'
    private static readonly PutBackMessage = "Its previous certificate authority, certificate and every environment's copy were put back, and the identity provider and the environments trust them again; nothing else was changed. Fix the cause, then install again."
    private static readonly PutBackPendingPrefix = 'The previous certificate authority, certificate and copies were put back, but these are not ready yet (check them in the cluster): '
    private static readonly PutBackRefusedPrefix = 'Putting the previous certificate authority back was refused for '
    private static readonly PutBackRefusedSuffix = ', so the cluster holds the new one there: check them in the cluster. The refusals:'
    private static readonly IdentityProvider = 'the identity provider'
    private static readonly ConsoleCopy = "the console's copy"
    private static readonly InterruptedMessage = "The identity provider's renewed certificate authority is in place, but an earlier renewal may not have restarted the identity provider onto it, and restarting it now did not finish; every copy still trusts the previous certificate authority too, so nothing verifies against the wrong one. Check the identity provider in the cluster, then install again."

    /** Set by Rotate when it found a current CA a copy still trusted beside an earlier one and restarted the IdP onto it. */
    private interrupted: Buffer | undefined

    public constructor(private readonly kubectl: IKubectl, private readonly clock: IInstallClock, private readonly scrub: string[])
    {
    }

    /** The current CA when Rotate finished an interrupted renewal (the caller seals it, as after a renewal); else undefined. */
    public get FinishedCa(): Buffer | undefined
    {
        return this.interrupted
    }

    /**
     * Whether a CA predates pragmatic-shared 0.18.14: it parses as a certificate whose name constraints do not permit
     * `localhost`. One that does not parse is not judged (false): renewing it would move every environment for no reason.
     * A bundle is judged by its first certificate.
     */
    public static IsLegacy(caPem: Buffer): boolean
    {
        let der: Buffer
        try
        {
            der = new X509Certificate(caPem).raw
        }
        catch
        {
            return false
        }
        return !IdpLoopbackHost.PermitsLocalhost(der)
    }

    /**
     * Renews the tenant's IdP CA when it predates 0.18.14 (see the class); undefined when it renewed nothing: no IdP TLS
     * Secret yet (a first install mints a current one), or a current CA (an interrupted earlier renewal is then finished
     * by restarting the IdP). Narrow follows either way, once the caller sealed the CA.
     */
    public async Rotate(hiveId: string, tenantId: string, baseDomain: string): Promise<IdpCaRotated | undefined>
    {
        const R = IdpCaRotation
        const previous = await this.IdpTls(tenantId)
        const previousCaText = previous?.[R.CaKey]
        if (previous === undefined || previousCaText === undefined)
        {
            return undefined
        }
        const previousCa = Buffer.from(previousCaText, R.Base64)
        if (!R.IsLegacy(previousCa))
        {
            await this.FinishInterrupted(hiveId, tenantId, previousCa)
            return undefined
        }
        this.RememberKey(previous[R.ServerKeyKey])
        const seeds = new InClusterIdpSeedSource(undefined, baseDomain)
        const ca = seeds.SeedFor(tenantId).ca
        const fresh = seeds.TlsSecretManifestFor(tenantId)
        for (const item of (JSON.parse(fresh) as { items: Array<{ data: Record<string, string> }> }).items)
        {
            this.RememberKey(item.data[R.ServerKeyKey])
        }
        const idpName = K8sManifestBuilder.IdpNameOf(tenantId)
        const consoleCa = await this.ConsoleCa(tenantId)
        const journal = new RotationJournal()
        try
        {
            if (consoleCa !== undefined)
            {
                journal.ConsoleTrust = true
                await this.kubectl.ApplyServerSide(R.ConsoleCopyManifest(hiveId, tenantId, R.Bundle(ca, consoleCa)))
            }
            await this.Widen(hiveId, previousCa, ca, journal)
            await this.clock.Delay(R.SecretSyncMs)
            // The console deploys environments with the copy it read: one deployed before its copy refreshed holds the old CA alone.
            await this.Widen(hiveId, previousCa, ca, journal)
            for (const env of journal.Trust.filter(e => e.HasServer))
            {
                await this.kubectl.RolloutRestart(env.Namespace, env.Deployment)
                if (!await this.Ready(env.Namespace, env.Deployment))
                {
                    journal.FailedServer = env
                    throw new IdpCaRotationError(R.ServerNotRestartedPrefix + env.Name + R.ServerNotRestartedSuffix)
                }
            }
            journal.IdpTls = true
            await this.kubectl.ApplyServerSide(fresh)
            if (await this.kubectl.Find(idpName, R.DeploymentPrefix + idpName) !== undefined)
            {
                await this.kubectl.RolloutRestart(idpName, idpName)
                try
                {
                    await this.kubectl.RolloutStatus(idpName, idpName)
                }
                catch (waited)
                {
                    throw new IdpCaRotationError(R.WithDetail(R.IdpNotRestartedMessage, R.KubectlText(waited)))
                }
            }
        }
        catch (err)
        {
            const cause = err instanceof IdpCaRotationError ? err.message : R.WithDetail(R.RefusedMessage, R.KubectlText(err))
            throw await this.PutBack(journal, cause, hiveId, tenantId, previous, consoleCa)
        }
        return new IdpCaRotated(ca, journal.Trust.filter(e => e.HasServer).map(e => e.Name))
    }

    /**
     * Drops the IdP's earlier CAs from every copy that trusts its current one (the console's and each environment's),
     * keeping any other CA a copy holds; restarts nothing. Nothing to do for a legacy or missing CA, or a copy already narrow.
     */
    public async Narrow(hiveId: string, tenantId: string): Promise<void>
    {
        const R = IdpCaRotation
        const caText = (await this.IdpTls(tenantId))?.[R.CaKey]
        if (caText === undefined)
        {
            return
        }
        const ca = Buffer.from(caText, R.Base64)
        if (R.IsLegacy(ca) || R.CertificatesOf(ca).length !== 1)
        {
            return
        }
        const consoleCa = await this.ConsoleCa(tenantId)
        if (consoleCa !== undefined && R.IsWide(consoleCa, ca))
        {
            await this.kubectl.ApplyServerSide(R.ConsoleCopyManifest(hiveId, tenantId, R.Narrowed(consoleCa, ca)))
        }
        for (const env of await this.TrustingEnvironments(hiveId, ca))
        {
            if (R.IsWide(env.Held, ca))
            {
                await EnvServerSeedSource.ApplyIdpCa(this.kubectl, env.Name, R.Narrowed(env.Held, ca))
            }
        }
    }

    /**
     * A current CA that a copy still trusts beside an earlier IdP CA: a renewal stopped between writing the new leaf and
     * proving the IdP on it (a crash), so the IdP is restarted and awaited before Narrow takes the earlier CA away.
     */
    private async FinishInterrupted(hiveId: string, tenantId: string, ca: Buffer): Promise<void>
    {
        const R = IdpCaRotation
        const consoleCa = await this.ConsoleCa(tenantId)
        const wide = (consoleCa !== undefined && R.IsWide(consoleCa, ca)) || (await this.TrustingEnvironments(hiveId, ca)).some(e => R.IsWide(e.Held, ca))
        const idpName = K8sManifestBuilder.IdpNameOf(tenantId)
        if (!wide || await this.kubectl.Find(idpName, R.DeploymentPrefix + idpName) === undefined)
        {
            return
        }
        await this.kubectl.RolloutRestart(idpName, idpName)
        try
        {
            await this.kubectl.RolloutStatus(idpName, idpName)
        }
        catch (waited)
        {
            throw new IdpCaRotationError(R.WithDetail(R.InterruptedMessage, R.KubectlText(waited)))
        }
        this.interrupted = ca
    }

    /** Every environment trusting `previousCa` whose copy does not yet hold `ca` trusts both (its first content journaled). */
    private async Widen(hiveId: string, previousCa: Buffer, ca: Buffer, journal: RotationJournal): Promise<void>
    {
        const R = IdpCaRotation
        for (const env of await this.TrustingEnvironments(hiveId, previousCa))
        {
            if (R.Holds(env.Held, ca))
            {
                continue
            }
            if (!journal.Holds(env.Name))
            {
                journal.Trust.push(env)
            }
            await EnvServerSeedSource.ApplyIdpCa(this.kubectl, env.Name, R.Bundle(ca, env.Held))
        }
    }

    /**
     * Puts back what the journal says changed and answers the error the install stops with: the previous TLS Secret and
     * the IdP restarted onto it, the console's and every environment's previous copy, and the one server that did not
     * restart restarted once more (the others already trust the old CA too). Each is tried on its own; waits that end
     * without a ready workload are named, and so is each refused put-back with kubectl's text.
     */
    private async PutBack(journal: RotationJournal, cause: string, hiveId: string, tenantId: string, previous: Record<string, string>, consoleCa: Buffer | undefined): Promise<IdpCaRotationError>
    {
        const R = IdpCaRotation
        const idpName = K8sManifestBuilder.IdpNameOf(tenantId)
        const pending: string[] = []
        const refused: string[] = []
        const refusals: string[] = []
        const attempt = async (what: string, step: () => Promise<void>): Promise<void> =>
        {
            try
            {
                await step()
            }
            catch (err)
            {
                refused.push(what)
                refusals.push(R.KubectlText(err))
            }
        }
        if (journal.IdpTls)
        {
            await attempt(R.IdentityProvider, async () =>
            {
                await this.kubectl.ApplyServerSide(R.TlsManifest(idpName, InClusterIdpSeedSource.TlsSecretNameOf(tenantId), previous))
                if (await this.kubectl.Find(idpName, R.DeploymentPrefix + idpName) !== undefined)
                {
                    await this.kubectl.RolloutRestart(idpName, idpName)
                    if (!await this.Ready(idpName, idpName))
                    {
                        pending.push(R.IdentityProvider)
                    }
                }
            })
        }
        if (journal.ConsoleTrust && consoleCa !== undefined)
        {
            await attempt(R.ConsoleCopy, () => this.kubectl.ApplyServerSide(R.ConsoleCopyManifest(hiveId, tenantId, consoleCa)))
        }
        for (const env of journal.Trust)
        {
            await attempt(R.ServerNotRestartedPrefix + env.Name, () => EnvServerSeedSource.ApplyIdpCa(this.kubectl, env.Name, env.Held))
        }
        const failed = journal.FailedServer
        if (failed !== undefined)
        {
            await attempt(R.ServerNotRestartedPrefix + failed.Name, async () =>
            {
                await this.kubectl.RolloutRestart(failed.Namespace, failed.Deployment)
                if (!await this.Ready(failed.Namespace, failed.Deployment))
                {
                    pending.push(R.ServerNotRestartedPrefix + failed.Name)
                }
            })
        }
        const stopped = R.StoppedPrefix + cause
        if (refused.length > 0)
        {
            const detail = refusals.filter(r => r !== R.NoDetail).join(R.Space)
            return new IdpCaRotationError(R.WithDetail(stopped + R.Space + R.PutBackRefusedPrefix + refused.join(R.ListSeparator) + R.PutBackRefusedSuffix, detail))
        }
        const outcome = pending.length === 0 ? R.PutBackMessage : R.PutBackPendingPrefix + pending.join(R.ListSeparator) + R.End
        return new IdpCaRotationError(stopped + R.Space + outcome)
    }

    /** Whether a Deployment's rollout wait ends ready. */
    private async Ready(namespace: string, deployment: string): Promise<boolean>
    {
        return await this.kubectl.RolloutStatus(namespace, deployment).then(() => true, () => false)
    }

    /** The IdP TLS Secret's data (base64 values, as kubectl returned them), or undefined. */
    private async IdpTls(tenantId: string): Promise<Record<string, string> | undefined>
    {
        const R = IdpCaRotation
        return R.DataOf(await this.kubectl.Find(K8sManifestBuilder.IdpNameOf(tenantId), R.SecretPrefix + InClusterIdpSeedSource.TlsSecretNameOf(tenantId)))
    }

    /** The CA the console's own copy holds, or undefined (no console installed yet, or a copy without one). */
    private async ConsoleCa(tenantId: string): Promise<Buffer | undefined>
    {
        const R = IdpCaRotation
        const text = R.DataOf(await this.kubectl.Find(K8sManifestBuilder.SystemNamespace, R.SecretPrefix + TenantAdminBootstrap.IdpCaSecretNameOf(tenantId)))?.[R.CaKey]
        return text === undefined ? undefined : Buffer.from(text, R.Base64)
    }

    /** The hive's environments (their namespaces carry the hive label) whose `<env>-idp-ca` Secret trusts `ca`. */
    private async TrustingEnvironments(hiveId: string, ca: Buffer): Promise<TrustingEnvironment[]>
    {
        const R = IdpCaRotation
        const prefix = K8sManifestBuilder.EnvNamespacePrefix
        const found: TrustingEnvironment[] = []
        for (const namespace of await this.kubectl.ListNamespacesBySelector(K8sManifestBuilder.HiveLabelSelectorOf(hiveId), prefix))
        {
            const name = namespace.slice(prefix.length)
            const held = R.DataOf(await this.kubectl.Find(namespace, R.SecretPrefix + EnvServerSeedSource.IdpCaSecretNameOf(name)))?.[R.CaKey]
            if (held === undefined || !R.Holds(Buffer.from(held, R.Base64), ca))
            {
                continue
            }
            const server = await this.kubectl.Find(namespace, R.DeploymentPrefix + K8sManifestBuilder.ServerDeploymentOf(name))
            found.push(new TrustingEnvironment(name, namespace, Buffer.from(held, R.Base64), server !== undefined))
        }
        return found
    }

    /** Records a server key's printable forms (the base64 a Secret carries, and the PEM text) for scrubbing. */
    private RememberKey(base64: string | undefined): void
    {
        if (base64 !== undefined && base64.length > 0)
        {
            this.scrub.push(base64, Buffer.from(base64, IdpCaRotation.Base64).toString(IdpCaRotation.Utf8).trim())
        }
    }

    /** The console's IdP CA copy as the bootstrap renders it (same name, labels and field manager), holding `ca`. */
    private static ConsoleCopyManifest(hiveId: string, tenantId: string, ca: Buffer): string
    {
        const set = new BootstrapSecretSet(hiveId)
        set.Add(TenantAdminBootstrap.IdpCaSecretNameOf(tenantId), { [IdpCaRotation.CaKey]: ca })
        return set.RenderManifest()
    }

    /** The IdP TLS Secret (as the install's seed renders it) holding exactly `data` (base64 values, as kubectl returned them). */
    private static TlsManifest(namespace: string, name: string, data: Record<string, string>): string
    {
        const set = new IdpSecretSet(namespace)
        set.Add(name, new Map(Object.entries(data).map(([key, value]) => [key, Buffer.from(value, IdpCaRotation.Base64)])))
        return set.RenderManifest()
    }

    /** `first` then every certificate of `rest`: a PEM bundle. */
    private static Bundle(first: Buffer, rest: Buffer): Buffer
    {
        return Buffer.concat([IdpCaRotation.Terminated(first), IdpCaRotation.Terminated(rest)])
    }

    /**
     * `ca` first, then what `held` trusts other than an earlier CA of the IdP: one named like it that predates 0.18.14 (the
     * kind a renewal replaces). A current CA of another DevCa issuer, or any other CA, stays.
     */
    private static Narrowed(held: Buffer, ca: Buffer): Buffer
    {
        const R = IdpCaRotation
        const subject = R.SubjectOf(ca)
        const own = R.CertificatesOf(ca)[0]
        const others = R.Blocks(held).filter(block =>
        {
            const pem = Buffer.from(block, R.Utf8)
            const earlier = R.SubjectOf(pem) === subject && R.IsLegacy(pem)
            return !earlier && block.replace(R.Whitespace, R.NoDetail) !== own
        })
        return Buffer.concat([R.Terminated(ca), ...others.map(block => Buffer.from(block + R.Newline, R.Utf8))])
    }

    /** Whether `held` trusts `ca` and also an earlier CA of the same IdP. */
    private static IsWide(held: Buffer, ca: Buffer): boolean
    {
        const R = IdpCaRotation
        return R.Holds(held, ca) && R.CertificatesOf(R.Narrowed(held, ca)).length !== R.CertificatesOf(held).length
    }

    /** Whether the bundle `held` contains the (single) certificate `ca`. */
    private static Holds(held: Buffer, ca: Buffer): boolean
    {
        const own = IdpCaRotation.CertificatesOf(ca)[0]
        return own !== undefined && IdpCaRotation.CertificatesOf(held).includes(own)
    }

    /** A certificate's subject; empty for one that does not parse. */
    private static SubjectOf(pem: Buffer): string
    {
        try
        {
            return new X509Certificate(pem).subject
        }
        catch
        {
            return IdpCaRotation.NoDetail
        }
    }

    /** The PEM certificate blocks of a bundle, as written. */
    private static Blocks(pem: Buffer): string[]
    {
        return pem.toString(IdpCaRotation.Utf8).match(IdpCaRotation.CertificateBlock) ?? []
    }

    /** The PEM certificate blocks of a bundle, whitespace removed (so two copies compare equal). */
    private static CertificatesOf(pem: Buffer): string[]
    {
        return IdpCaRotation.Blocks(pem).map(block => block.replace(IdpCaRotation.Whitespace, IdpCaRotation.NoDetail))
    }

    /** PEM bytes ending in a newline, so two concatenate into a valid bundle. */
    private static Terminated(pem: Buffer): Buffer
    {
        const R = IdpCaRotation
        return pem.toString(R.Utf8).endsWith(R.Newline) ? pem : Buffer.concat([pem, Buffer.from(R.Newline, R.Utf8)])
    }

    /** A Secret's non-empty string `data`, or undefined when absent. */
    private static DataOf(json: string | undefined): Record<string, string> | undefined
    {
        if (json === undefined)
        {
            return undefined
        }
        const data = (JSON.parse(json) as { data?: Record<string, unknown> }).data
        if (data === undefined)
        {
            return undefined
        }
        return Object.fromEntries(Object.entries(data).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].length > 0))
    }

    private static KubectlText(err: unknown): string
    {
        return err instanceof KubectlError ? err.message.trim() : IdpCaRotation.NoDetail
    }

    private static WithDetail(message: string, detail: string): string
    {
        return detail === IdpCaRotation.NoDetail ? message : message + IdpCaRotation.Space + detail
    }
}
