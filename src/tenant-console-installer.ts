import { randomBytes } from 'node:crypto'
import { DevCaError } from '@pragmatic-tech-ai/pragmatic-identity-source-oidc'
import { ConsoleAdvertRegistry, type ConsoleAdvertRecord, type IConsoleAdvertLookup } from './console-advert-registry.js'
import { type ConsoleFingerprintKeys, EffectiveRegistry, type HiveConsoleSpec, IdpAdminError, IdpAdminTransportError, IdpDatabaseSecret, IngressTlsPolicy, IngressTlsSource, K8sManifestBuilder, HiveBackend, type HiveRecord, type TenantRecord, TenantConsoleAdmission } from '@pragmatic-tech-ai/pragmatic-tenant-plane'
import type { IOwnerResetRecorder } from './console-owner-resets.js'
import { ConsoleRetention } from './console-retention.js'
import { DevCaHostOutsideDomainError, DevCaKeyMissingError, type IDevCertificateIssuer, type IssuedCertificate } from './dev-certificate-authority.js'
import { SystemInstallClock, type IInstallClock, KubectlError, PortForwardError, type IKubectl } from '@pragmatic-tech-ai/pragmatic-kube'
import { type IInstallOrchestratorSource } from './hive-agent-installer.js'
import { HiveConsoleSpecs, InvalidHiveConsoleError } from './hive-console-spec.js'
import { ComponentAssetUnavailableError, ImageVerificationError, type IImageVerifier, type IKeyStore, type VerifiedImage, ReleaseApp, ReleaseDescriptorMismatchError, ReleaseDescriptorUnverifiedError } from '@pragmatic-tech-ai/pragmatic-release-toolkit'
import type { ConsoleReleaseDescriptors } from './console-release-descriptors.js'
import { ReleaseManifestUnavailableError } from './release/github-release-manifest-source.js'
import { ReleaseDescriptorsUnavailableError } from './release/release-descriptor-source.js'
import { ReleaseDescriptorsConfigMap, ReleaseDescriptorsTooLargeError } from './release-descriptors-config-map.js'
import { IdpSecretSet, InClusterIdpSeedSource } from './in-cluster-idp-seed.js'
import { InHiveIdpUnavailableError, type IInHiveIdpAdmin, type InHiveOwnerPassword } from './in-hive-idp-admin.js'
import type { PlatformImageSigner } from './platform-signing-key.js'
import { UnknownTenantError } from './platform-directory.js'
import { UnknownHiveError } from '@pragmatic-tech-ai/pragmatic-platform-link'
import { TenantAdminBootstrap } from './tenant-admin-bootstrap.js'
import { DevPlatformImages, PlatformImages, type IPlatformImages } from './platform-images.js'
import { OwnerAccountMissingError, OwnerIdpRefusedError, OwnerNotRecordedError, IdpUnreachableError } from './tenant-provisioning-service.js'
import { AppliedConfigurationKeys } from '@pragmatic-tech-ai/pragmatic-configuration-runtime'
import { ConsoleBootstrapSplit } from './console-bootstrap-split.js'
import { ComponentConfigurationReadiness, ConfigurationReadinessState } from './component-configuration-readiness.js'

/** Where a console install stands. Values are the wire strings. */
export enum ConsoleInstallState
{
    Installing = 'installing',
    Deployed = 'deployed',
    Failed = 'failed',
    /** The running console reported itself to the control plane (its advert); derived from the stored advert, so it survives a restart. */
    Reported = 'reported',
}

/** The console install's steps, in the order they run. Values are the wire strings. */
export enum ConsoleInstallStep
{
    CheckingAgent = 'checking-agent',
    PreparingCertificates = 'preparing-certificates',
    ReadingReleaseDescriptors = 'reading-release-descriptors',
    ApplyingConsole = 'applying-console',
    StoringSecrets = 'storing-secrets',
    /** The console restarts onto the release and becomes ready (the realm sign-in service is not touched yet). */
    WaitingForRollout = 'waiting-for-rollout',
    /** The console prepares the configurations for the release's descriptors; the install waits on their status. */
    PreparingConfiguration = 'preparing-configuration',
    /** The realm sign-in service rolls onto the release's image and becomes ready. */
    RollingOutIdp = 'rolling-out-idp',
    SeedingOwner = 'seeding-owner',
}

/** A console install's state as the operator sees it. Never carries a secret. */
export type ConsoleInstallStatus = {
    state: ConsoleInstallState
    step: ConsoleInstallStep
    startedAt: string
    finishedAt?: string
    error?: string
    consoleUrl?: string
    devCaFile?: string
    /** Reported only: when the console last reported, and whether that was over a day ago. */
    reportedAt?: string
    stale?: boolean
}

/** What a console removal kept in the cluster; `notice` when that could not be listed (the removal itself succeeded). */
export type ConsoleRemovalOutcome = { retained: string[]; notice?: string }

/** The hive has no console settings yet. Maps to 409. */
export class ConsoleNotConfiguredError extends Error
{
    private static readonly ErrorName = 'ConsoleNotConfiguredError'
    private static readonly Text = 'This hive has no console settings. Set where the console is served first.'

    public constructor()
    {
        super(ConsoleNotConfiguredError.Text)
        this.name = ConsoleNotConfiguredError.ErrorName
    }
}

/** A console install cannot run for this hive (not Local, the agent channel is off, or the id is unsafe). Maps to 409. */
export class ConsoleInstallUnavailableError extends Error
{
    private static readonly ErrorName = 'ConsoleInstallUnavailableError'

    public constructor(message: string)
    {
        super(message)
        this.name = ConsoleInstallUnavailableError.ErrorName
    }
}

/** A console install is already running for the hive. Maps to 409. */
export class ConsoleInstallInProgressError extends Error
{
    private static readonly ErrorName = 'ConsoleInstallInProgressError'
    private static readonly MessagePrefix = 'A console install is already running for hive '

    public constructor(hiveId: string)
    {
        super(ConsoleInstallInProgressError.MessagePrefix + hiveId)
        this.name = ConsoleInstallInProgressError.ErrorName
    }
}

/** A step's own plain-sentence failure (agent missing, TLS Secret unusable, no trust root, hive deleted). */
class ConsoleInstallStepError extends Error
{
    private static readonly ErrorName = 'ConsoleInstallStepError'

    public constructor(message: string)
    {
        super(message)
        this.name = ConsoleInstallStepError.ErrorName
    }
}

/** Finds the hive and its tenant; satisfied by PlatformDirectory. */
export interface IConsoleDirectory
{
    GetHive(id: string): HiveRecord | undefined
    GetTenant(id: string): TenantRecord | undefined
}

/** Approves the console image for a hive: the ref the hive pulls, verified against its trust root. */
export interface IConsoleImageApproval
{
    Approve(hive: HiveRecord, baseImage: string): Promise<VerifiedImage>
}

/**
 * Signs the image for a hive that trusts the platform key (as InClusterEnvironmentRuntime does for server images), then verifies it
 * fail-closed against the hive's trust root. The approved entry is the pulled ref only (a plain allow-list; no digest).
 */
export class PlatformConsoleImageApproval implements IConsoleImageApproval
{
    public constructor(private readonly signer: PlatformImageSigner | undefined, private readonly verifier: IImageVerifier)
    {
    }

    public async Approve(hive: HiveRecord, baseImage: string): Promise<VerifiedImage>
    {
        const imageRef = EffectiveRegistry.For(hive).ImageRef(baseImage)
        if (this.signer !== undefined && this.signer.SignsFor(hive))
        {
            await this.signer.Sign(imageRef)
        }
        await this.verifier.Verify(imageRef, hive.trustRootRef)
        return { imageRef }
    }
}

/** The images one console install runs: the tenant-admin pod (with its pragmatic-postgres sidecar) and the in-hive IdP. */
type ConsoleImages = { tenantAdmin: string; idp: string; postgres: string; release: string | undefined }

/** The IdP's CA + admin token for the bootstrap, and the seed Secrets to apply (undefined when the running IdP's are reused). */
type IdpMaterial = { ca: Buffer; adminToken: string; secretsManifest: string | undefined; scrub: string[] }

/** The IdP database Secret to apply (undefined when the IdP namespace already holds one) and its values' printable forms, for scrubbing. */
type IdpDatabaseMaterial = { secretsManifest: string | undefined; scrub: string[] }

/** One install's mutable state; the installer hands out copies only. */
class ConsoleInstallRun
{
    public state = ConsoleInstallState.Installing
    public step = ConsoleInstallStep.CheckingAgent
    public finishedAt: string | undefined
    public error: string | undefined
    public consoleUrl: string | undefined
    public devCaFile: string | undefined
    public settled: Promise<void> = Promise.resolve()
    /** Secret values seen by this run, scrubbed from any failure text. Dropped once the run settles. */
    public readonly secrets: string[] = []

    public constructor(public readonly hiveId: string, public readonly startedAt: string)
    {
    }

    public Snapshot(): ConsoleInstallStatus
    {
        const status: ConsoleInstallStatus = { state: this.state, step: this.step, startedAt: this.startedAt }
        if (this.finishedAt !== undefined)
        {
            status.finishedAt = this.finishedAt
        }
        if (this.error !== undefined)
        {
            status.error = this.error
        }
        if (this.consoleUrl !== undefined)
        {
            status.consoleUrl = this.consoleUrl
        }
        if (this.devCaFile !== undefined)
        {
            status.devCaFile = this.devCaFile
        }
        return status
    }
}

/**
 * Installs a hive's tenant console (and its in-hive IdP) from the control plane, in the background, on a Local hive whose agent
 * already runs: check the agent's token Secret, prepare the console's TLS (development leaf, existing Secret, or cert-manager),
 * approve the image, render the bootstrap (agent token reused, master key / fingerprint key / IdP credentials kept across
 * reinstalls), apply it (all but the IdP's Deployment), store its Secrets server-side, restart the console and wait for it,
 * wait (bounded) until it has prepared the IdP's configuration for the release's IdP descriptor (stopping, the IdP
 * untouched, when it refuses it), then apply the IdP's Deployment with the release's image, restart and wait for it, then
 * seed the Owner account.
 * The console's pinned-image allow-list holds only the server image approved by this install, so a console-created environment
 * runs (and rolls to) that ref only: after a platform release the operator reinstalls the console to approve the new server image
 * (the console says so: ImageNotApprovedError). One install per hive at a time; the latest status is kept in memory only. No
 * secret value leaves this class except on kubectl's stdin and into the sealed store: not in arguments, logs, errors or status.
 */
export class TenantConsoleInstaller
{
    public static readonly ConsolePort = 7100
    public static readonly IdpPort = 9443
    /** How long the install waits for the console to prepare the IdP's configuration, and how often it reads its status. */
    public static readonly PreparationTimeoutMs = 180_000
    public static readonly PreparationPollMs = 3_000

    private static readonly NotLocalMessage = 'The console cannot be installed in this hive from here: the control plane does not manage its cluster.'
    private static readonly ChannelOffMessage = 'The console cannot be installed: the agent channel is not configured (set PRAGMATIC_AGENT_CHANNEL_PORT or PRAGMATIC_AGENT_CHANNEL_URL to the channel of the platform edge).'
    private static readonly UnsafeIdMessage = "The console cannot be installed in this hive: its id is not a valid Kubernetes label value. Recreate the hive with a lowercase id (a-z, 0-9, '-')."
    private static readonly AgentMissingMessage = 'Install the agent first: the console uses the hive agent token.'
    private static readonly AdmissionUnservedMessage = "This cluster does not serve ValidatingAdmissionPolicy (admissionregistration.k8s.io/v1), so the console's admission fence cannot be applied. The console needs Kubernetes 1.30 or newer."
    private static readonly NoTrustRootMessage = 'This hive has no trust root, so the console image cannot be verified. Give the hive a trust root first.'
    private static readonly TlsSecretPrefix = 'The TLS Secret '
    private static readonly TlsSecretSuffix = ' was not found in pragmatic-system, or is not a kubernetes.io/tls Secret.'
    private static readonly KeptUnlistedPrefix = 'The console was removed, but the objects it kept could not be listed: '
    private static readonly TrailingStop = /\.+$/
    private static readonly HiveGoneMessage = 'The install stopped: the hive was deleted while it ran.'
    private static readonly MixedReleaseMessage = "The console cannot be installed: its tenant-admin, IdP and pragmatic-postgres images come from different platform releases, so no one release's descriptors describe them. Withdraw the newer partial release or publish a full one."
    private static readonly DescriptorsHeldPrefix = 'The release descriptors ConfigMap in pragmatic-system belongs to hive '
    private static readonly DescriptorsHeldSuffix = ': one cluster holds the console of one hive only. Remove that console first.'
    private static readonly RefusedPrefix = "The realm sign-in service's configuration does not validate for version "
    private static readonly RefusedChange = ' of this release: change '
    private static readonly RefusedWhere = ' in the tenant admin console (Configuration, pragmatic-tenant-idp), then install again. The identity provider was not changed. ('
    private static readonly RefusedEnd = ')'
    private static readonly SettingsSeparator = ', '
    private static readonly NotPreparedMessage = "The tenant admin console did not prepare the realm sign-in service's configuration for this release within 3 minutes. The identity provider was not changed; open the console's Configuration page, then install again."
    private static readonly ConfigMapPrefix = 'configmap/'
    private static readonly StepFailureMessages: Readonly<Record<ConsoleInstallStep, string>> = {
        [ConsoleInstallStep.CheckingAgent]: 'Could not check the hive agent.',
        [ConsoleInstallStep.PreparingCertificates]: "Could not prepare the console's certificates and settings.",
        [ConsoleInstallStep.ReadingReleaseDescriptors]: "Could not read the release's component descriptors.",
        [ConsoleInstallStep.ApplyingConsole]: 'Could not apply the console to the cluster.',
        [ConsoleInstallStep.StoringSecrets]: "Could not store the console's Secrets in the cluster.",
        [ConsoleInstallStep.WaitingForRollout]: 'The console did not roll out.',
        [ConsoleInstallStep.PreparingConfiguration]: "Could not read whether the console prepared the identity provider's configuration for this release.",
        [ConsoleInstallStep.RollingOutIdp]: 'The identity provider did not roll out.',
        [ConsoleInstallStep.SeedingOwner]: "Could not seed the tenant's Owner in the in-hive identity provider.",
    }
    /** Errors whose message is a safe plain sentence (or names only a resource) and helps the operator; others add nothing. */
    private static readonly ShowableErrors: ReadonlyArray<abstract new (...args: never[]) => Error> = [
        KubectlError, PortForwardError, IdpAdminError, IdpAdminTransportError, InHiveIdpUnavailableError, OwnerNotRecordedError,
        OwnerAccountMissingError, OwnerIdpRefusedError, IdpUnreachableError, ImageVerificationError, DevCaKeyMissingError,
        DevCaHostOutsideDomainError, InvalidHiveConsoleError, DevCaError, ReleaseDescriptorsUnavailableError, ReleaseDescriptorMismatchError,
        ReleaseDescriptorUnverifiedError, ReleaseManifestUnavailableError, ComponentAssetUnavailableError, ReleaseDescriptorsTooLargeError,
    ]
    private static readonly HttpsScheme = 'https'
    private static readonly HttpsPrefix = 'https://'
    private static readonly WildcardPrefix = '*.'
    private static readonly Dot = '.'
    private static readonly SecretPrefix = 'secret/'
    private static readonly DeploymentPrefix = 'deployment/'
    private static readonly IngressPrefix = 'ingress/'
    private static readonly DetailSeparator = ' '
    private static readonly Redacted = '[REDACTED]'
    private static readonly LogPrefix = '[console-install] hive '
    private static readonly LogStepInfix = ' failed at '
    private static readonly LogErrorInfix = ': '
    private static readonly UnknownErrorName = 'Error'
    private static readonly RerecordFailedInfix = ': recording the Owner reset again after the IdP call failed: '
    private static readonly Base64 = 'base64'
    private static readonly Hex = 'hex'
    private static readonly Utf8 = 'utf8'
    private static readonly TlsCertKey = 'tls.crt'
    private static readonly TlsKeyKey = 'tls.key'
    private static readonly IdpCaKey = 'ca.crt'
    private static readonly ApiVersionKey = 'apiVersion'
    private static readonly KindKey = 'kind'
    private static readonly TypeKey = 'type'
    private static readonly MetadataKey = 'metadata'
    private static readonly NameKey = 'name'
    private static readonly NamespaceKey = 'namespace'
    private static readonly LabelsKey = 'labels'
    private static readonly DataKey = 'data'
    private static readonly ItemsKey = 'items'
    private static readonly ApiVersionCore = 'v1'
    private static readonly SecretKind = 'Secret'
    private static readonly ListKind = 'List'
    private static readonly MasterKeyBytes = 32
    private static readonly IdpServerKeyKey = 'server.key'
    private static readonly SecretResource = 'secret'
    private static readonly TlsCopyLabel = 'pragmatic/tls-copy'
    private static readonly TlsCopyValue = 'true'
    private static readonly TlsCopyRunLabel = 'pragmatic/tls-copy-run'
    private static readonly CopyRunBytes = 6
    private static readonly LabelNotEqual = '!='
    private static readonly SelectorSeparator = ','
    private static readonly LabelAssign = '='
    private static readonly PartialIdpPrefix = 'The identity provider Secret '
    private static readonly PartialIdpInfix = ' is missing from '
    private static readonly PartialIdpWhile = ' while '
    private static readonly PartialIdpSuffix = ' exists. Restore it, or delete both to give the identity provider a new certificate (every environment then needs its identity provider CA re-applied).'
    private static readonly IdpDatabaseIncompletePrefix = 'The identity provider database Secret '
    private static readonly IdpDatabaseIncompleteInfix = ' in '
    private static readonly IdpDatabaseIncompleteSuffix = ' lacks one of its keys (superuser, password, database-url). Restore them; the install never replaces it, since its passwords open the stored data.'
    private static readonly IdpDatabaseKeys: readonly string[] = [IdpDatabaseSecret.SuperuserKey, IdpDatabaseSecret.PasswordKey, IdpDatabaseSecret.UrlKey]

    private readonly runs = new Map<string, ConsoleInstallRun>()
    private readonly manifests = new K8sManifestBuilder()

    public constructor(
        private readonly directory: IConsoleDirectory,
        private readonly orchestrators: IInstallOrchestratorSource,
        private readonly bootstrap: TenantAdminBootstrap,
        private readonly fingerprints: ConsoleFingerprintKeys,
        private readonly devCa: IDevCertificateIssuer,
        private readonly idpAdmin: IInHiveIdpAdmin,
        private readonly images: IConsoleImageApproval,
        private readonly trustRoots: IKeyStore,
        private readonly agentChannelUrl: string | undefined,
        private readonly clock: IInstallClock = new SystemInstallClock(),
        private readonly adverts?: IConsoleAdvertLookup,
        private readonly ownerResets?: IOwnerResetRecorder,
        private readonly platformImages: IPlatformImages = new DevPlatformImages(),
        private readonly releaseDescriptors?: ConsoleReleaseDescriptors)
    {
    }

    /**
     * Whether the control plane can remove this hive's console: a Local hive with a safe id. Unlike an install (Start), the agent
     * channel does not matter (removal never talks to the agent), so turning the channel off never strands a console in the cluster.
     */
    public CanUninstall(hive: HiveRecord): boolean
    {
        return hive.cluster.backend === HiveBackend.Local && K8sManifestBuilder.IsValidHiveId(hive.id)
    }

    /** Begins an install in the background and returns its first status. Throws for an unknown, unconfigured, unsupported or busy hive. */
    public Start(hiveId: string): ConsoleInstallStatus
    {
        const hive = this.directory.GetHive(hiveId)
        if (hive === undefined)
        {
            throw new UnknownHiveError(hiveId)
        }
        const spec = hive.console
        if (spec === undefined)
        {
            throw new ConsoleNotConfiguredError()
        }
        if (hive.cluster.backend !== HiveBackend.Local)
        {
            throw new ConsoleInstallUnavailableError(TenantConsoleInstaller.NotLocalMessage)
        }
        if (!K8sManifestBuilder.IsValidHiveId(hive.id))
        {
            throw new ConsoleInstallUnavailableError(TenantConsoleInstaller.UnsafeIdMessage)
        }
        const channelUrl = this.agentChannelUrl
        if (channelUrl === undefined)
        {
            throw new ConsoleInstallUnavailableError(TenantConsoleInstaller.ChannelOffMessage)
        }
        const tenantAdminImage = this.platformImages.ImageOf(ReleaseApp.TenantAdmin)
        const idpImage = this.platformImages.ImageOf(ReleaseApp.TenantIdp)
        // The console stores in its own pragmatic-postgres (a sidecar): a release without that image cannot run a console.
        const postgresImage = this.platformImages.ImageOf(ReleaseApp.Postgres)
        if (tenantAdminImage === undefined || idpImage === undefined || postgresImage === undefined)
        {
            throw new ConsoleInstallUnavailableError(PlatformImages.NoReleaseMessage)
        }
        if (this.IsInstalling(hiveId))
        {
            throw new ConsoleInstallInProgressError(hiveId)
        }
        const tenant = this.directory.GetTenant(hive.tenantId)
        if (tenant === undefined)
        {
            throw new UnknownTenantError(hive.tenantId)
        }
        // Read beside the images, so the descriptors delivered are those of the one release all console images come from.
        if (this.releaseDescriptors?.IsMixed() === true)
        {
            throw new ConsoleInstallUnavailableError(TenantConsoleInstaller.MixedReleaseMessage)
        }
        const release = this.releaseDescriptors?.ReleaseOfConsole()
        const run = new ConsoleInstallRun(hiveId, new Date(this.clock.Now()).toISOString())
        this.runs.set(hiveId, run)
        run.settled = this.Run(run, hive, tenant, spec, channelUrl, { tenantAdmin: tenantAdminImage, idp: idpImage, postgres: postgresImage, release })
        return run.Snapshot()
    }

    /**
     * The latest install's status for the hive; undefined when none has run since the control plane started and no advert answers.
     * A usable advert of this hive (it still has its console) turns a deployed install (or no install since a restart) into
     * Reported. With a run in memory the advert counts only when it is not older than the run's start: the new console's first advert
     * arrives during the rollout wait, before the run finishes, while an advert from before the reinstall began is the old
     * console's and leaves the install deployed. Installing and Failed are never overridden.
     */
    public StatusFor(hiveId: string): ConsoleInstallStatus | undefined
    {
        const base = this.runs.get(hiveId)?.Snapshot()
        if (base?.state === ConsoleInstallState.Installing || base?.state === ConsoleInstallState.Failed)
        {
            return base
        }
        const advert = this.UsableAdvertOf(hiveId)
        if (advert === undefined || (base !== undefined && !TenantConsoleInstaller.ReportedSince(advert.reportedAt, base.startedAt)))
        {
            return base
        }
        const seed: ConsoleInstallStatus = base ?? { state: ConsoleInstallState.Deployed, step: ConsoleInstallStep.SeedingOwner, startedAt: advert.firstReportedAt, finishedAt: advert.firstReportedAt }
        return {
            ...seed,
            state: ConsoleInstallState.Reported,
            consoleUrl: advert.consoleUrl,
            reportedAt: advert.reportedAt,
            stale: ConsoleAdvertRegistry.IsStale(advert, new Date(this.clock.Now())),
        }
    }

    /** The hive's tenant advert when it comes from this hive and the hive still has its console. */
    private UsableAdvertOf(hiveId: string): ConsoleAdvertRecord | undefined
    {
        const hive = this.directory.GetHive(hiveId)
        if (hive === undefined || this.adverts === undefined)
        {
            return undefined
        }
        return ConsoleAdvertRegistry.UsableFor(this.adverts, hive.tenantId, [hive])
    }

    /** Whether an advert reported at `reportedAt` is not older than the run's `startedAt`; fails closed on an unreadable time. */
    private static ReportedSince(reportedAt: string, startedAt: string): boolean
    {
        return Date.parse(reportedAt) >= Date.parse(startedAt)
    }

    public IsInstalling(hiveId: string): boolean
    {
        return this.runs.get(hiveId)?.state === ConsoleInstallState.Installing
    }

    /** Resolves once the hive's latest install has settled, with its final status. For tests and tooling. */
    public async WhenSettled(hiveId: string): Promise<ConsoleInstallStatus | undefined>
    {
        const run = this.runs.get(hiveId)
        if (run === undefined)
        {
            return undefined
        }
        await run.settled
        return run.Snapshot()
    }

    /**
     * Deletes TenantConsoleRemovalManifest objects (the console, its grants and the in-hive IdP's serving objects) and this hive's TLS
     * key copies in the IdP namespace, then returns what it kept that exists: the console's and the IdP's data and Secrets
     * (ConsoleRetention) and the environment namespaces the console created, which keep running unmanaged until a reinstall adopts
     * them (or the hive delete removes them). Leaves a console another hive owns (its Deployment carries another hive's label)
     * untouched and returns nothing. A KubectlError from the removal itself propagates; once it is done, a KubectlError while
     * listing what was kept does not undo it: the outcome then has no retained list and a notice saying so.
     */
    public async Uninstall(hive: HiveRecord): Promise<ConsoleRemovalOutcome>
    {
        const C = TenantConsoleInstaller
        const kubectl = this.orchestrators.For(hive).Kubectl
        const deployment = await kubectl.Find(K8sManifestBuilder.SystemNamespace, C.DeploymentPrefix + K8sManifestBuilder.TenantAdminNameOf(hive.tenantId))
        if (deployment !== undefined && K8sManifestBuilder.HiveOf(JSON.parse(deployment)) !== hive.id)
        {
            return { retained: [] }
        }
        await kubectl.DeleteManifest(this.manifests.TenantConsoleRemovalManifest(hive.tenantId, hive.id, await TenantConsoleAdmission.ServedBy(kubectl)))
        await C.RemoveDescriptors(kubectl, hive.id)
        // The IdP Ingress is gone, so the private-key copies it served are swept too.
        await kubectl.DeleteBySelector(K8sManifestBuilder.IdpNameOf(hive.tenantId), C.SecretResource, C.TlsCopySelectorOf(hive.id))
        try
        {
            const kept = await ConsoleRetention.ExistingOf(kubectl, hive.tenantId)
            const environments = await kubectl.ListNamespacesBySelector(K8sManifestBuilder.HiveLabelSelectorOf(hive.id), K8sManifestBuilder.EnvNamespacePrefix)
            return { retained: [...kept, ...environments] }
        }
        catch (err)
        {
            if (!(err instanceof KubectlError))
            {
                throw err
            }
            return { retained: [], notice: C.KeptUnlistedPrefix + err.message.trim().replace(C.TrailingStop, '') + C.Dot }
        }
    }

    /**
     * On hive delete: drops the hive's fingerprint key and, when it is the tenant's console hive (it has the console, or its install
     * sealed the credentials and the console was removed since), the in-hive IdP credentials. Those are keyed by tenant: deleting
     * another hive of the same tenant must not strand the console hive's IdP. A console removal keeps them: the kept IdP Secrets and
     * environments still use that CA, and the half-pair check on a reinstall relies on them.
     */
    public async Forget(hive: HiveRecord): Promise<void>
    {
        await this.fingerprints.Remove(hive.id)
        if (hive.console !== undefined || await this.idpAdmin.OwnerOf(hive.tenantId) === hive.id)
        {
            await this.idpAdmin.Forget(hive.tenantId)
        }
    }

    /** On tenant delete: drops the tenant's in-hive IdP credentials. */
    public async ForgetTenant(tenantId: string): Promise<void>
    {
        await this.idpAdmin.Forget(tenantId)
    }

    /**
     * On tenant delete only: drops the tenant's recorded Owner reset. A console removal or hive delete keeps it, because the
     * console's data volume (with its sessions and its applied marker) survives both and a reinstall must still see the reset.
     */
    public async ForgetOwnerReset(tenantId: string): Promise<void>
    {
        await this.ownerResets?.Forget(tenantId)
    }

    /**
     * Sets a fresh in-hive Owner password and returns it once. Refused while an install runs or before the console is configured.
     * The reset is recorded after those guards and BEFORE the IdP call, so a reset that succeeds is always followed by the console
     * ending the Owner's sessions at its next advert (a reset that then fails costs only one harmless extra revoke); a failed record
     * fails the reset with nothing changed. After the IdP call succeeded the reset is recorded once more (a new value, best
     * effort, a failure logged by error name only): the console may advert, revoke and mark the first value applied while the
     * IdP call is still running, and a session opened with the old password in that window must end too.
     */
    public async ResetOwnerPassword(hiveId: string): Promise<InHiveOwnerPassword>
    {
        const hive = this.directory.GetHive(hiveId)
        if (hive === undefined)
        {
            throw new UnknownHiveError(hiveId)
        }
        if (hive.console === undefined)
        {
            throw new ConsoleNotConfiguredError()
        }
        if (this.IsInstalling(hiveId))
        {
            throw new ConsoleInstallInProgressError(hiveId)
        }
        const tenant = this.directory.GetTenant(hive.tenantId)
        if (tenant === undefined)
        {
            throw new UnknownTenantError(hive.tenantId)
        }
        await this.ownerResets?.Record(tenant.id)
        const reset = await this.idpAdmin.ResetOwnerPassword(hive, tenant)
        await this.RecordAgain(hiveId, tenant.id)
        return reset
    }

    private async RecordAgain(hiveId: string, tenantId: string): Promise<void>
    {
        const C = TenantConsoleInstaller
        try
        {
            await this.ownerResets?.Record(tenantId)
        }
        catch (err)
        {
            console.error(C.LogPrefix + hiveId + C.RerecordFailedInfix + (err instanceof Error ? err.name : C.UnknownErrorName))
        }
    }

    /** Runs the steps; never rejects: a failure is recorded on the run. */
    private async Run(run: ConsoleInstallRun, hive: HiveRecord, tenant: TenantRecord, spec: HiveConsoleSpec, channelUrl: string, images: ConsoleImages): Promise<void>
    {
        // Yield first, so Start returns before any step runs.
        await Promise.resolve()
        const C = TenantConsoleInstaller
        const t = tenant.id
        const system = K8sManifestBuilder.SystemNamespace
        const idpName = K8sManifestBuilder.IdpNameOf(t)
        try
        {
            const kubectl = this.orchestrators.For(hive).Kubectl
            const host = HiveConsoleSpecs.HostOf(spec, t)
            this.Enter(run, ConsoleInstallStep.CheckingAgent)
            if (await kubectl.Find(system, C.SecretPrefix + K8sManifestBuilder.AgentTokenSecretNameOf(hive.id)) === undefined)
            {
                throw new ConsoleInstallStepError(C.AgentMissingMessage)
            }
            // Without the admission fence the console's cluster-wide grants would be unfenced: refuse the cluster before any apply.
            if (!await TenantConsoleAdmission.ServedBy(kubectl))
            {
                throw new ConsoleInstallStepError(C.AdmissionUnservedMessage)
            }
            this.Enter(run, ConsoleInstallStep.PreparingCertificates)
            const trustRootRef = hive.trustRootRef
            if (trustRootRef === undefined || trustRootRef.length === 0)
            {
                throw new ConsoleInstallStepError(C.NoTrustRootMessage)
            }
            // A legacy record may predate today's console rules (e.g. a TLS Secret named like the IdP's own): refuse it here too.
            HiveConsoleSpecs.Validate(spec, t)
            const tlsCopy = await this.TlsMaterial(run, kubectl, spec, t, host)
            // Each distinct console image is approved for the hive (the dev image serves both, so it is approved once).
            const approved = [await this.images.Approve(hive, images.tenantAdmin)]
            if (images.idp !== images.tenantAdmin)
            {
                approved.push(await this.images.Approve(hive, images.idp))
            }
            const fingerprintKey = await this.fingerprints.Ensure(hive.id)
            C.Remember(run, fingerprintKey)
            // Minted here on a first install (not inside the bootstrap), so it is in the scrub list either way.
            const masterKey = await C.ExistingMasterKey(kubectl, t) ?? randomBytes(C.MasterKeyBytes)
            C.Remember(run, masterKey)
            const idp = await this.IdpMaterialOf(kubectl, t, spec.baseDomain)
            run.secrets.push(idp.adminToken, ...idp.scrub)
            // The IdP's own Postgres (its database Secret beside its TLS and admin token in the IdP namespace; the bootstrap renders
            // the sidecar from the release's pragmatic-postgres image under that Secret's conventional name).
            const idpDatabase = await C.IdpDatabaseOf(kubectl, t)
            run.secrets.push(...idpDatabase.scrub)
            // Read before the Apply rewrites it: the copy the IdP Ingress served until now (installs before copies were labelled).
            const legacyCopies = C.LegacyTlsCopies(await kubectl.Find(idpName, C.IngressPrefix + idpName), spec, t)
            const bootstrap = await this.bootstrap.GenerateBootstrap({
                tenant,
                hive,
                tenantAdminImage: images.tenantAdmin,
                postgresImage: images.postgres,
                tenantPlanePort: C.ConsolePort,
                baseDomain: spec.baseDomain,
                externalScheme: C.HttpsScheme,
                channelUrl,
                reuseAgentToken: true,
                console: { host, ingressTls: spec.tls, ingressNamespace: HiveConsoleSpecs.IngressNamespaceOf(spec) },
                fingerprintKey,
                masterKey,
                verifiedImages: approved,
                idp: {
                    image: images.idp,
                    port: C.IdpPort,
                    tlsSecretName: InClusterIdpSeedSource.TlsSecretNameOf(t),
                    adminTokenSecretName: InClusterIdpSeedSource.AdminSecretNameOf(t),
                    adminTokenRef: InClusterIdpSeedSource.AdminTokenKey,
                    ca: idp.ca,
                    adminToken: idp.adminToken,
                    ingressTls: spec.tls,
                },
                trustRootPublicKey: await this.trustRoots.PublicKey(trustRootRef),
            })
            this.Enter(run, ConsoleInstallStep.ReadingReleaseDescriptors)
            // The release's component descriptors, each checked against the digest its signature binds (fail closed: the console
            // validates every component's configuration against them); written only once everything else is applied.
            const descriptors = await this.DescriptorsOf(kubectl, hive.id, images.release)
            this.Enter(run, ConsoleInstallStep.ApplyingConsole)
            const stale = this.StaleTlsObjects(spec, t, hive.id)
            if (stale !== undefined)
            {
                await kubectl.DeleteManifest(stale)
            }
            // The IdP's Deployment (the release's IdP image) waits until its configuration is prepared for that image; the empty
            // configuration objects go server-side (a client-side apply would clear data a client-side apply wrote).
            const parts = ConsoleBootstrapSplit.Of(bootstrap.manifest, t)
            await kubectl.Apply(parts.Console)
            this.Enter(run, ConsoleInstallStep.StoringSecrets)
            await kubectl.ApplyServerSide(bootstrap.secrets.RenderManifest())
            if (idp.secretsManifest !== undefined)
            {
                await kubectl.ApplyServerSide(idp.secretsManifest)
            }
            if (idpDatabase.secretsManifest !== undefined)
            {
                await kubectl.ApplyServerSide(idpDatabase.secretsManifest)
            }
            // The current copies land first, stamped with this run, so the IdP Ingress never serves without its certificate.
            const copyRun = randomBytes(C.CopyRunBytes).toString(C.Hex)
            if (spec.tls.source === IngressTlsSource.Development && tlsCopy !== undefined)
            {
                await kubectl.ApplyServerSide(C.TlsSecretManifest(K8sManifestBuilder.TenantConsoleDevTlsSecretNameOf(t), system, tlsCopy, hive.id, copyRun))
                await kubectl.ApplyServerSide(C.TlsSecretManifest(IngressTlsPolicy.DevelopmentSecretName, idpName, tlsCopy, hive.id, copyRun))
            }
            else if (spec.tls.source === IngressTlsSource.ExistingSecret && tlsCopy !== undefined)
            {
                await kubectl.ApplyServerSide(C.TlsSecretManifest(spec.tls.secretName as string, idpName, tlsCopy, hive.id, copyRun))
            }
            // Then earlier TLS copies in the IdP namespace (another source, another existing-secret name), which hold a private key
            // nothing references any more: every labelled copy not stamped by this run, and the unlabelled legacy ones.
            await kubectl.DeleteBySelector(idpName, C.SecretResource, C.StaleTlsCopySelectorOf(hive.id, copyRun))
            if (legacyCopies.length > 0)
            {
                await kubectl.DeleteManifest(C.SecretIdentities(idpName, legacyCopies))
            }
            await this.idpAdmin.Remember(t, idp.ca, idp.adminToken)
            await this.idpAdmin.RememberOwner(t, hive.id)
            // Last before the restarts: a step that failed earlier leaves the running console the descriptors of the release it runs
            // (a mounted ConfigMap updates in place), and the restarted console reads this release's.
            // Before the console restarts: the empty configuration objects it writes into, and a running IdP's new labels on its
            // own pod template (so the console finds it as a configuration target while the IdP does not roll).
            if (parts.ConfigurationObjects !== undefined)
            {
                await kubectl.ApplyServerSide(parts.ConfigurationObjects)
            }
            const hold = parts.IdpHold(await kubectl.Find(idpName, C.DeploymentPrefix + idpName))
            if (hold !== undefined)
            {
                await kubectl.ApplyServerSide(hold)
            }
            await C.DeliverDescriptors(kubectl, hive.id, descriptors)
            // The console first: it restarts onto the release (and its new Secrets), and once ready prepares every configuration
            // for the release's descriptors.
            await kubectl.RolloutRestart(system, K8sManifestBuilder.TenantAdminNameOf(t))
            this.Enter(run, ConsoleInstallStep.WaitingForRollout)
            await kubectl.RolloutStatus(system, K8sManifestBuilder.TenantAdminNameOf(t))
            this.Enter(run, ConsoleInstallStep.PreparingConfiguration)
            const idpDigest = ReleaseDescriptorsConfigMap.DigestOf(descriptors, ReleaseApp.TenantIdp)
            if (idpDigest !== undefined)
            {
                await this.AwaitPrepared(kubectl, idpName, idpDigest)
            }
            // Then the IdP: its Deployment with the release's image, restarted for the new Secrets.
            this.Enter(run, ConsoleInstallStep.RollingOutIdp)
            if (parts.IdpDeployment !== undefined)
            {
                await kubectl.Apply(parts.IdpDeployment)
            }
            await kubectl.RolloutRestart(idpName, idpName)
            await kubectl.RolloutStatus(idpName, idpName)
            this.Enter(run, ConsoleInstallStep.SeedingOwner)
            await this.idpAdmin.SeedOwner(hive, tenant)
            run.state = ConsoleInstallState.Deployed
            run.consoleUrl = C.HttpsPrefix + host
            if (spec.tls.source === IngressTlsSource.Development)
            {
                run.devCaFile = this.devCa.CaFileOf(spec.baseDomain)
            }
            run.finishedAt = new Date(this.clock.Now()).toISOString()
        }
        catch (err)
        {
            this.Fail(run, err)
        }
        finally
        {
            run.secrets.splice(0)
        }
    }

    /**
     * Waits (bounded) until the console prepared the IdP's configuration for `digest`, the release's IdP descriptor
     * (ComponentConfigurationReadiness over the status it records). A refusal stops the install naming the settings that
     * must change; no answer in PreparationTimeoutMs stops it too. Either way the IdP has not been touched.
     */
    private async AwaitPrepared(kubectl: IKubectl, namespace: string, digest: string): Promise<void>
    {
        const C = TenantConsoleInstaller
        const resource = C.ConfigMapPrefix + AppliedConfigurationKeys.ObjectNamePrefix + ReleaseApp.TenantIdp
        for (let attempt = 0; ; attempt += 1)
        {
            const readiness = ComponentConfigurationReadiness.Of(await kubectl.Find(namespace, resource), digest)
            if (readiness.State === ConfigurationReadinessState.Ready) return
            if (readiness.State === ConfigurationReadinessState.Refused && readiness.Refusal !== undefined)
            {
                const r = readiness.Refusal
                throw new ConsoleInstallStepError(C.RefusedPrefix + r.ComponentVersion + C.RefusedChange + r.Settings.join(C.SettingsSeparator) + C.RefusedWhere + r.Reason + C.RefusedEnd)
            }
            if (attempt * C.PreparationPollMs >= C.PreparationTimeoutMs) throw new ConsoleInstallStepError(C.NotPreparedMessage)
            await this.clock.Delay(C.PreparationPollMs)
        }
    }

    /**
     * The ConfigMap manifest of `release`'s descriptors to deliver (undefined: nothing, no release or none signed). Refuses
     * early (before anything is applied) when the object belongs to another hive: the name is one per cluster (pragmatic-shared's
     * builder mounts it by that name), so two hives' consoles cannot share a cluster. Delivery checks again.
     */
    private async DescriptorsOf(kubectl: IKubectl, hiveId: string, release: string | undefined): Promise<string | undefined>
    {
        TenantConsoleInstaller.RefuseHeld(await TenantConsoleInstaller.FindDescriptors(kubectl), hiveId)
        return release === undefined || this.releaseDescriptors === undefined ? undefined : await this.releaseDescriptors.ManifestFor(release, hiveId)
    }

    /**
     * Writes the release descriptors ConfigMap on every install, from what the cluster holds at that moment: another hive's
     * object refuses the install; this hive's is replaced by a server-side apply preconditioned on the resourceVersion just
     * read (a write in between fails the apply instead of being overwritten), which drops a key an earlier release carried;
     * an object no install wrote (no hive label) is deleted first, so none of its keys survive. With nothing to deliver,
     * removes the object this hive's earlier install wrote (an unowned one is left alone).
     */
    private static async DeliverDescriptors(kubectl: IKubectl, hiveId: string, manifest: string | undefined): Promise<void>
    {
        const C = TenantConsoleInstaller
        if (manifest === undefined)
        {
            await C.RemoveDescriptors(kubectl, hiveId)
            return
        }
        const existing = await C.FindDescriptors(kubectl)
        C.RefuseHeld(existing, hiveId)
        if (existing !== undefined && ReleaseDescriptorsConfigMap.HiveOf(existing) === undefined)
        {
            await kubectl.DeleteManifest(ReleaseDescriptorsConfigMap.IdentityManifest())
            await kubectl.ApplyServerSide(manifest)
            return
        }
        const version = ReleaseDescriptorsConfigMap.ResourceVersionOf(existing)
        await kubectl.ApplyServerSide(version === undefined ? manifest : ReleaseDescriptorsConfigMap.WithResourceVersion(manifest, version))
    }

    /** Deletes the release descriptors ConfigMap when this hive's install wrote it (never another hive's), read just before. */
    private static async RemoveDescriptors(kubectl: IKubectl, hiveId: string): Promise<void>
    {
        const existing = await TenantConsoleInstaller.FindDescriptors(kubectl)
        if (ReleaseDescriptorsConfigMap.BelongsTo(existing, hiveId))
        {
            await kubectl.DeleteManifest(ReleaseDescriptorsConfigMap.IdentityManifest())
        }
    }

    private static async FindDescriptors(kubectl: IKubectl): Promise<string | undefined>
    {
        return await kubectl.Find(ReleaseDescriptorsConfigMap.Namespace, ReleaseDescriptorsConfigMap.Resource())
    }

    /** Throws the step's sentence when the object belongs to a hive other than `hiveId`. */
    private static RefuseHeld(existing: string | undefined, hiveId: string): void
    {
        const C = TenantConsoleInstaller
        const holder = ReleaseDescriptorsConfigMap.HiveOf(existing)
        if (holder !== undefined && holder !== hiveId)
        {
            throw new ConsoleInstallStepError(C.DescriptorsHeldPrefix + holder + C.DescriptorsHeldSuffix)
        }
    }

    /**
     * The certificate to copy into pragmatic-system / the IdP namespace: development issues a leaf for the wildcard, the base domain
     * and the exact console and IdP hosts (a host deeper than one label under the base domain is not covered by the wildcard);
     * existing-secret reads the operator's Secret (which must be a kubernetes.io/tls Secret with both keys); cert-manager needs none.
     */
    private async TlsMaterial(run: ConsoleInstallRun, kubectl: IKubectl, spec: HiveConsoleSpec, tenantId: string, host: string): Promise<IssuedCertificate | undefined>
    {
        const C = TenantConsoleInstaller
        switch (spec.tls.source)
        {
            case IngressTlsSource.Development:
            {
                const bd = spec.baseDomain
                const hosts = [C.WildcardPrefix + bd, bd]
                for (const exact of [host, K8sManifestBuilder.IdpBrowserHostOf(tenantId, bd)])
                {
                    if (!C.CoveredBy(exact, bd) && !hosts.includes(exact))
                    {
                        hosts.push(exact)
                    }
                }
                const issued = await this.devCa.Issue(bd, hosts)
                C.RememberTlsKey(run, issued)
                return issued
            }
            case IngressTlsSource.ExistingSecret:
            {
                const name = spec.tls.secretName as string
                const issued = C.TlsSecretOf(await kubectl.Find(K8sManifestBuilder.SystemNamespace, C.SecretPrefix + name))
                if (issued === undefined)
                {
                    throw new ConsoleInstallStepError(C.TlsSecretPrefix + name + C.TlsSecretSuffix)
                }
                C.RememberTlsKey(run, issued)
                return issued
            }
            default:
                return undefined
        }
    }

    /** Whether the base domain's wildcard covers `host` (exactly one label under it). */
    private static CoveredBy(host: string, baseDomain: string): boolean
    {
        const suffix = TenantConsoleInstaller.Dot + baseDomain
        return host.endsWith(suffix) && !host.slice(0, -suffix.length).includes(TenantConsoleInstaller.Dot)
    }

    /** The cert + key of a kubernetes.io/tls Secret (as kubectl returns it), or undefined when absent, of another type or incomplete. */
    private static TlsSecretOf(json: string | undefined): IssuedCertificate | undefined
    {
        const C = TenantConsoleInstaller
        if (json === undefined)
        {
            return undefined
        }
        const doc = JSON.parse(json) as { type?: unknown; data?: Record<string, unknown> }
        const cert = doc.data?.[C.TlsCertKey]
        const key = doc.data?.[C.TlsKeyKey]
        if (doc.type !== IngressTlsPolicy.TlsSecretType || typeof cert !== 'string' || typeof key !== 'string' || cert.length === 0 || key.length === 0)
        {
            return undefined
        }
        return { cert: Buffer.from(cert, C.Base64), key: Buffer.from(key, C.Base64) }
    }

    /** The master key of the console's existing seed Secret (a reinstall keeps the data PVC readable), or undefined on a first install. */
    private static async ExistingMasterKey(kubectl: IKubectl, tenantId: string): Promise<Buffer | undefined>
    {
        const C = TenantConsoleInstaller
        const json = await kubectl.Find(K8sManifestBuilder.SystemNamespace, C.SecretPrefix + K8sManifestBuilder.TenantAdminSeedSecretNameOf(tenantId))
        const value = C.DataOf(json, TenantAdminBootstrap.MasterKeyKey)
        return value === undefined ? undefined : Buffer.from(value, C.Base64)
    }

    /**
     * The running IdP's CA and admin token when both its Secrets exist (a reinstall must not rotate them: every environment's IdP CA
     * copy and the console's admin client depend on them; the caller refreshes the sealed copy from what is read here); freshly minted
     * material plus the Secrets to apply (one server-side apply of both, so a half pair is unlikely) when neither exists. Exactly one
     * present: after a completed install (its credentials are sealed) environments may already trust that CA, so minting would silently
     * rotate it and the install fails with a sentence naming the missing Secret; with nothing sealed it is the leftover of a first install
     * that never completed, so it is deleted and the IdP minted fresh.
     */
    private async IdpMaterialOf(kubectl: IKubectl, tenantId: string, baseDomain: string): Promise<IdpMaterial>
    {
        const C = TenantConsoleInstaller
        const ns = K8sManifestBuilder.IdpNameOf(tenantId)
        const tlsName = InClusterIdpSeedSource.TlsSecretNameOf(tenantId)
        const adminName = InClusterIdpSeedSource.AdminSecretNameOf(tenantId)
        const ca = C.DataOf(await kubectl.Find(ns, C.SecretPrefix + tlsName), C.IdpCaKey)
        const token = C.DataOf(await kubectl.Find(ns, C.SecretPrefix + adminName), InClusterIdpSeedSource.AdminTokenKey)
        if (ca !== undefined && token !== undefined)
        {
            return { ca: Buffer.from(ca, C.Base64), adminToken: Buffer.from(token, C.Base64).toString(C.Utf8), secretsManifest: undefined, scrub: [] }
        }
        if (ca !== undefined || token !== undefined)
        {
            const [missing, present] = ca === undefined ? [tlsName, adminName] : [adminName, tlsName]
            if (await this.idpAdmin.Holds(tenantId))
            {
                throw new ConsoleInstallStepError(C.PartialIdpPrefix + missing + C.PartialIdpInfix + ns + C.PartialIdpWhile + present + C.PartialIdpSuffix)
            }
            await kubectl.DeleteManifest(C.SecretIdentities(ns, [present]))
        }
        const seeds = new InClusterIdpSeedSource(undefined, baseDomain)
        const seed = seeds.SeedFor(tenantId)
        const manifest = seeds.SecretsManifestFor(tenantId)
        return { ca: seed.ca, adminToken: seed.adminToken, secretsManifest: manifest, scrub: C.ServerKeyFormsOf(manifest) }
    }

    /**
     * The IdP's database Secret: an existing one is kept as it is (its passwords open the IdP's stored data, so a reinstall must
     * never rotate them) and only its values are recorded for scrubbing; one lacking a key fails the install with a sentence
     * naming it (never overwritten); none is minted fresh (random superuser and role passwords, the URL over the role password).
     */
    private static async IdpDatabaseOf(kubectl: IKubectl, tenantId: string): Promise<IdpDatabaseMaterial>
    {
        const C = TenantConsoleInstaller
        const ns = K8sManifestBuilder.IdpNameOf(tenantId)
        const name = IdpDatabaseSecret.NameOf(tenantId)
        const json = await kubectl.Find(ns, C.SecretPrefix + name)
        if (json !== undefined)
        {
            const values = C.IdpDatabaseKeys.map(key => C.DataOf(json, key))
            const present = values.filter((v): v is string => v !== undefined)
            if (present.length !== values.length)
            {
                throw new ConsoleInstallStepError(C.IdpDatabaseIncompletePrefix + name + C.IdpDatabaseIncompleteInfix + ns + C.IdpDatabaseIncompleteSuffix)
            }
            return { secretsManifest: undefined, scrub: present.flatMap(v => [v, Buffer.from(v, C.Base64).toString(C.Utf8)]) }
        }
        const data = IdpDatabaseSecret.Mint()
        const set = new IdpSecretSet(ns)
        set.Add(name, data)
        return { secretsManifest: set.RenderManifest(), scrub: [...data.values()].flatMap(v => [v.toString(C.Base64), v.toString(C.Utf8)]) }
    }

    /** The freshly minted IdP server key's printable forms (base64 as the Secret carries it, and the PEM text), for scrubbing. */
    private static ServerKeyFormsOf(manifest: string): string[]
    {
        const C = TenantConsoleInstaller
        const items = (JSON.parse(manifest) as { items?: Array<{ data?: Record<string, string> }> }).items ?? []
        return items.flatMap(i =>
        {
            const key = i.data?.[C.IdpServerKeyKey]
            return key === undefined ? [] : [key, Buffer.from(key, C.Base64).toString(C.Utf8).trim()]
        })
    }

    /**
     * Unlabelled TLS copies in the IdP namespace an install from before copies were labelled may have left: the Secret the IdP Ingress
     * named until now and, unless the new source is development, pragmatic-dev-tls. Never the copy the new choice uses, and never the
     * IdP's own TLS or admin Secrets.
     */
    private static LegacyTlsCopies(ingressJson: string | undefined, spec: HiveConsoleSpec, tenantId: string): string[]
    {
        const idpName = K8sManifestBuilder.IdpNameOf(tenantId)
        const names = new Set<string>()
        if (ingressJson !== undefined)
        {
            const tls = (JSON.parse(ingressJson) as { spec?: { tls?: Array<{ secretName?: unknown }> } }).spec?.tls ?? []
            for (const entry of tls)
            {
                if (typeof entry.secretName === 'string' && entry.secretName.length > 0)
                {
                    names.add(entry.secretName)
                }
            }
        }
        if (spec.tls.source !== IngressTlsSource.Development)
        {
            names.add(IngressTlsPolicy.DevelopmentSecretName)
        }
        for (const kept of [IngressTlsPolicy.SecretNameFor(spec.tls, idpName), InClusterIdpSeedSource.TlsSecretNameOf(tenantId), InClusterIdpSeedSource.AdminSecretNameOf(tenantId)])
        {
            names.delete(kept)
        }
        return [...names]
    }

    /** A v1 List of Secret identities (name + namespace only) to delete by name; absent ones are tolerated. */
    private static SecretIdentities(namespace: string, names: readonly string[]): string
    {
        const C = TenantConsoleInstaller
        const items = names.map(name => ({ [C.ApiVersionKey]: C.ApiVersionCore, [C.KindKey]: C.SecretKind, [C.MetadataKey]: { [C.NameKey]: name, [C.NamespaceKey]: namespace } }))
        return JSON.stringify({ [C.ApiVersionKey]: C.ApiVersionCore, [C.KindKey]: C.ListKind, [C.ItemsKey]: items })
    }

    /** Selects all of this hive's TLS key copies (in the IdP namespace: what a console removal sweeps). */
    private static TlsCopySelectorOf(hiveId: string): string
    {
        const C = TenantConsoleInstaller
        return K8sManifestBuilder.HiveLabelSelectorOf(hiveId) + C.SelectorSeparator + C.TlsCopyLabel + C.LabelAssign + C.TlsCopyValue
    }

    /** Selects this hive's TLS key copies an earlier run left (no run stamp, or another one): what an install sweeps after its own. */
    private static StaleTlsCopySelectorOf(hiveId: string, copyRun: string): string
    {
        const C = TenantConsoleInstaller
        return C.TlsCopySelectorOf(hiveId) + C.SelectorSeparator + C.TlsCopyRunLabel + C.LabelNotEqual + copyRun
    }

    /** A non-empty base64 `data` entry of a Secret's JSON, or undefined. */
    private static DataOf(json: string | undefined, key: string): string | undefined
    {
        if (json === undefined)
        {
            return undefined
        }
        const value = (JSON.parse(json) as { data?: Record<string, unknown> }).data?.[key]
        return typeof value === 'string' && value.length > 0 ? value : undefined
    }

    /**
     * Objects an earlier install with another TLS source may have left that this one does not render: the TLS-read Role and RoleBinding
     * (cert-manager copies no Secret) and this tenant's development TLS copy (any non-development source). Undefined when none.
     */
    private StaleTlsObjects(spec: HiveConsoleSpec, tenantId: string, hiveId: string): string | undefined
    {
        const C = TenantConsoleInstaller
        const names = new Set<string>()
        if (spec.tls.source !== IngressTlsSource.Development)
        {
            names.add(K8sManifestBuilder.TenantConsoleDevTlsSecretNameOf(tenantId))
        }
        if (!IngressTlsPolicy.CopiesSecret(spec.tls))
        {
            names.add(K8sManifestBuilder.TenantConsoleTlsRoleNameOf(tenantId))
        }
        const removal = JSON.parse(this.manifests.TenantConsoleRemovalManifest(tenantId, hiveId)) as { items: Array<{ metadata: { name: string } }> }
        const items = removal.items.filter(i => names.has(i.metadata.name))
        return items.length === 0 ? undefined : JSON.stringify({ [C.ApiVersionKey]: C.ApiVersionCore, [C.KindKey]: C.ListKind, [C.ItemsKey]: items })
    }

    /**
     * A hive-labelled kubernetes.io/tls Secret manifest, also labelled as a TLS copy stamped with its install run (so a later install
     * can sweep every copy but its own); applied server-side through kubectl's stdin, never written anywhere else.
     */
    private static TlsSecretManifest(name: string, namespace: string, tls: IssuedCertificate, hiveId: string, copyRun: string): string
    {
        const C = TenantConsoleInstaller
        const labels = { ...K8sManifestBuilder.HiveLabelsOf(hiveId), [C.TlsCopyLabel]: C.TlsCopyValue, [C.TlsCopyRunLabel]: copyRun }
        return JSON.stringify({
            [C.ApiVersionKey]: C.ApiVersionCore,
            [C.KindKey]: C.SecretKind,
            [C.TypeKey]: IngressTlsPolicy.TlsSecretType,
            [C.MetadataKey]: { [C.NameKey]: name, [C.NamespaceKey]: namespace, [C.LabelsKey]: labels },
            [C.DataKey]: { [C.TlsCertKey]: tls.cert.toString(C.Base64), [C.TlsKeyKey]: tls.key.toString(C.Base64) },
        })
    }

    /** Records a key's printable forms (base64 and hex) for scrubbing. */
    private static Remember(run: ConsoleInstallRun, key: Buffer): void
    {
        run.secrets.push(key.toString(TenantConsoleInstaller.Base64), key.toString(TenantConsoleInstaller.Hex))
    }

    /** Records a TLS private key's printable forms (PEM text and the base64 a Secret carries) for scrubbing. */
    private static RememberTlsKey(run: ConsoleInstallRun, tls: IssuedCertificate): void
    {
        run.secrets.push(tls.key.toString(TenantConsoleInstaller.Utf8), tls.key.toString(TenantConsoleInstaller.Base64))
    }

    /** Moves the run to its next step; stops it (throws) when the hive was deleted meanwhile. */
    private Enter(run: ConsoleInstallRun, step: ConsoleInstallStep): void
    {
        run.step = step
        if (this.directory.GetHive(run.hiveId) === undefined)
        {
            throw new ConsoleInstallStepError(TenantConsoleInstaller.HiveGoneMessage)
        }
    }

    /** Records a failed step: the fixed step message (or the step's own sentence), plus a showable error's text, every secret scrubbed. */
    private Fail(run: ConsoleInstallRun, err: unknown): void
    {
        const C = TenantConsoleInstaller
        const showable = C.ShowableErrors.some(ctor => err instanceof ctor)
        // A showable error's own text, scrubbed of every secret this run saw and of secret-looking runs; undefined otherwise.
        const detail = showable ? C.Scrub(run, (err as Error).message) : undefined
        let message = err instanceof ConsoleInstallStepError ? err.message : C.StepFailureMessages[run.step]
        if (detail !== undefined)
        {
            message += C.DetailSeparator + detail
        }
        run.state = ConsoleInstallState.Failed
        run.error = C.Scrub(run, message)
        run.finishedAt = new Date(this.clock.Now()).toISOString()
        // The error's name, plus its scrubbed text only when it is a showable one: any other raw message may carry cluster output.
        const name = err instanceof Error ? err.name : C.UnknownErrorName
        const line = C.LogPrefix + run.hiveId + C.LogStepInfix + run.step + C.LogErrorInfix + name
        console.error(detail === undefined ? line : line + C.LogErrorInfix + detail)
    }

    /** Removes every secret value the run saw, then anything secret-looking (KubectlError.Redact), from a text. */
    private static Scrub(run: ConsoleInstallRun, text: string): string
    {
        let scrubbed = text
        for (const secret of run.secrets)
        {
            if (secret.length > 0)
            {
                scrubbed = scrubbed.split(secret).join(TenantConsoleInstaller.Redacted)
            }
        }
        return KubectlError.Redact(scrubbed)
    }
}
