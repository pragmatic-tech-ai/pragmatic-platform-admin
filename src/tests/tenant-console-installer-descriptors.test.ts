import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { OciUnavailableError, ReleaseApp } from '@pragmatic-tech-ai/pragmatic-release-toolkit'
import { ComponentConfigurationMounts, K8sManifestBuilder, type HiveRecord } from '@pragmatic-tech-ai/pragmatic-tenant-plane'
import { ConsoleReleaseDescriptors } from '../console-release-descriptors.js'
import type { IPlatformRelease } from '../platform-images.js'
import { ReleaseDescriptorSource } from '../release/release-descriptor-source.js'
import { ReleaseDescriptorsConfigMap } from '../release-descriptors-config-map.js'
import { ConsoleInstallState, ConsoleInstallStep, ConsoleInstallUnavailableError, TenantConsoleInstaller } from '../tenant-console-installer.js'
import { AppliedConfiguration, AppliedConfigurationCodec, AppliedConfigurationEntries, AppliedConfigurationKeys, ConfigurationPreparationRefusal, ConfigurationPreparationStatus } from '@pragmatic-tech-ai/pragmatic-configuration-runtime'
import type { ComponentDescriptorSet } from '@pragmatic-tech-ai/pragmatic-release-toolkit'
import { ConsoleFakeKubectl, ConsoleInstallFixture } from './console-install-fakes.js'
import { FakeAssets, FakeComponentsArtifact, FakeManifestSource, FakeReleaseRecords, ReleaseDescriptorFixtures as F } from './release-descriptor-fixtures.js'

type K8sItem = {
    apiVersion: string; kind: string
    metadata: { name: string; namespace?: string; labels?: Record<string, string>; annotations?: Record<string, string> }
    spec?: Record<string, unknown>; rules?: unknown[]; subjects?: unknown[]; roleRef?: unknown; data?: Record<string, string>; stringData?: Record<string, string>
}
type PodSpec = { containers: Array<{ name: string; volumeMounts?: unknown[] }>; initContainers?: Array<{ name: string }>; volumes: unknown[] }
type DeploymentSpec = { strategy: unknown; template: { metadata: { labels: Record<string, string> }; spec: PodSpec } }

/** The release each console app's image comes from, settable by a test. */
class FakePlatformRelease implements IPlatformRelease
{
    public readonly Versions = new Map<ReleaseApp, string | undefined>(ConsoleReleaseDescriptors.ConsoleApps.map(app => [app, F.Version]))

    public Set(version: string | undefined): void
    {
        for (const app of ConsoleReleaseDescriptors.ConsoleApps)
        {
            this.Versions.set(app, version)
        }
    }

    public ReleaseOf(app: ReleaseApp): string | undefined
    {
        return this.Versions.get(app)
    }
}

/** A console install fixture whose installer delivers descriptors through the real source over fake registry / GitHub reads. */
class DescriptorInstall
{
    public static readonly Hive = 'h1'
    public static readonly OtherHive = 'other-hive'
    public static readonly Tenant = 'acme'
    public static readonly DescriptorsVolume = 'release-descriptors'
    public static readonly RecreateStrategy = { type: 'Recreate' }
    public static readonly MismatchText = 'The release carries a component descriptor its signature does not bind: '
    public static readonly RegistryDown = 'registry unreachable'
    public static readonly RegistryDownText = 'the release registry is unreachable'
    public static readonly HeldText = 'belongs to hive ' + DescriptorInstall.OtherHive
    public static readonly RbacGroup = 'rbac.authorization.k8s.io'
    public static readonly ByName = ['get', 'patch']
    public static readonly ApplyCall = 'Apply'
    public static readonly ApplyServerSideCall = 'ApplyServerSide'
    public static readonly RolloutRestartCall = 'RolloutRestart'
    public static readonly DeleteManifestCall = 'DeleteManifest'
    public static readonly ConfigMapKind = 'ConfigMap'
    public static readonly DeploymentKind = 'Deployment'
    public static readonly SecretKind = 'Secret'
    public static readonly RoleKind = 'Role'
    public static readonly RoleBindingKind = 'RoleBinding'
    public static readonly ServiceAccountKind = 'ServiceAccount'
    public static readonly ReadingFailedText = "Could not read the release's component descriptors."
    public static readonly MixedPattern = /different platform releases/
    public static readonly ResourceVersion = '42'

    public readonly Release = new FakePlatformRelease()
    public readonly Records = new FakeReleaseRecords()
    public readonly Artifact = new FakeComponentsArtifact()
    public readonly Manifests = new FakeManifestSource()
    public readonly Assets = new FakeAssets()
    public readonly Delivery = new ConsoleReleaseDescriptors(this.Release, new ReleaseDescriptorSource(this.Records, this.Artifact, this.Manifests, this.Assets))

    /** A delivery whose release `version` has its components artifact. */
    public static WithRelease(version: string = F.Version, marker: string = F.Marker): DescriptorInstall
    {
        const d = new DescriptorInstall()
        d.Release.Set(version)
        d.Add(version, marker)
        return d
    }

    public Add(version: string, marker: string): void
    {
        const set = F.Set(marker)
        this.Records.Records.push(F.Record(version, set))
        this.Artifact.Sets.set(version, set)
    }

    public static Items(manifestJson: string): K8sItem[]
    {
        const parsed = JSON.parse(manifestJson) as { kind: string; items?: K8sItem[] }
        return parsed.kind === 'List' ? parsed.items ?? [] : [parsed as unknown as K8sItem]
    }

    public static IsDescriptors(manifestJson: string): boolean
    {
        return DescriptorInstall.Items(manifestJson).some(i => i.kind === DescriptorInstall.ConfigMapKind && i.metadata.name === ReleaseDescriptorsConfigMap.Name)
    }

    /** The descriptors ConfigMaps the installer applied server-side, in order. */
    public static DescriptorApplies(fx: ConsoleInstallFixture): K8sItem[]
    {
        return fx.Kubectl.ServerApplied.filter(m => DescriptorInstall.IsDescriptors(m)).flatMap(m => DescriptorInstall.Items(m))
    }

    public static Find(items: K8sItem[], kind: string, namespace: string, name: string): K8sItem
    {
        const item = items.find(i => i.kind === kind && i.metadata.namespace === namespace && i.metadata.name === name)
        assert.ok(item !== undefined, kind + ' ' + namespace + '/' + name + ' is rendered')
        return item
    }

    /** Whether the descriptors ConfigMap identity was deleted. */
    public static DeletedDescriptors(fx: ConsoleInstallFixture): boolean
    {
        return fx.Kubectl.Deleted.includes(ReleaseDescriptorsConfigMap.IdentityManifest())
    }

    /** An existing descriptors ConfigMap labelled for `hiveId` (undefined: no hive label). */
    public static PutDescriptors(fx: ConsoleInstallFixture, hiveId: string | undefined): void
    {
        fx.Kubectl.Put(ReleaseDescriptorsConfigMap.Namespace, ReleaseDescriptorsConfigMap.Resource(), DescriptorInstall.DescriptorsObject(hiveId))
    }

    /** A descriptors ConfigMap as kubectl returns it, labelled for `hiveId` (undefined: no hive label). */
    public static DescriptorsObject(hiveId: string | undefined, resourceVersion: string = DescriptorInstall.ResourceVersion): unknown
    {
        const D = DescriptorInstall
        const metadata = hiveId === undefined
            ? { name: ReleaseDescriptorsConfigMap.Name, resourceVersion }
            : { name: ReleaseDescriptorsConfigMap.Name, resourceVersion, labels: K8sManifestBuilder.HiveLabelsOf(hiveId) }
        return { kind: D.ConfigMapKind, metadata }
    }

    /** Queues what the descriptors ConfigMap Finds answer, in turn (a cluster changing while the install runs). */
    public static QueueDescriptors(fx: ConsoleInstallFixture, answers: Array<string | undefined>): void
    {
        fx.Kubectl.FindAnswers.set(ConsoleFakeKubectl.Key(ReleaseDescriptorsConfigMap.Namespace, ReleaseDescriptorsConfigMap.Resource()), answers)
    }

    /** The position of the first call of `verb` (with an argument matching `arg`, when given). */
    public static IndexOf(fx: ConsoleInstallFixture, verb: string, arg?: (call: string[]) => boolean): number
    {
        return fx.Kubectl.Calls.findIndex(c => c[0] === verb && (arg === undefined || arg(c)))
    }

    public static async Installed(fx: ConsoleInstallFixture): Promise<void>
    {
        fx.Installer.Start(DescriptorInstall.Hive)
        assert.equal((await fx.Installer.WhenSettled(DescriptorInstall.Hive))?.state, ConsoleInstallState.Deployed)
    }
}

describe('TenantConsoleInstaller: the release descriptors ConfigMap', () =>
{
    const D = DescriptorInstall
    let fx: ConsoleInstallFixture

    afterEach(() =>
    {
        fx?.Dispose()
    })

    it('is built from the console\'s release components artifact and applied server-side after the console and its Secrets, before the restarts', async () =>
    {
        const d = D.WithRelease()
        fx = await ConsoleInstallFixture.Create({ descriptors: d.Delivery })
        await D.Installed(fx)
        const [configMap] = D.DescriptorApplies(fx)
        assert.ok(configMap !== undefined)
        assert.equal(configMap.metadata.namespace, K8sManifestBuilder.SystemNamespace)
        assert.equal(configMap.metadata.annotations?.[ReleaseDescriptorsConfigMap.ReleaseAnnotation], F.Version)
        assert.deepEqual(configMap.data, ReleaseDescriptorsConfigMap.DataOf(d.Artifact.Sets.get(F.Version) as NonNullable<ReturnType<typeof d.Artifact.Sets.get>>))
        // Last of the writes: a failed earlier step leaves the running console the descriptors of the release it runs.
        const serverApplies = fx.Kubectl.ServerApplied
        assert.equal(serverApplies.findIndex(m => D.IsDescriptors(m)), serverApplies.length - 1)
        const at = fx.Kubectl.Calls.map(c => c[0]).lastIndexOf(D.ApplyServerSideCall)
        assert.ok(D.IndexOf(fx, D.ApplyCall) < at)
        assert.ok(at < D.IndexOf(fx, D.RolloutRestartCall))
    })

    it('a release cut before the artifact delivers the component.json assets its manifest names', async () =>
    {
        const d = new DescriptorInstall()
        const set = F.Set(F.PreArtifactMarker)
        d.Release.Set(F.OlderVersion)
        d.Records.Records.push(F.Record(F.OlderVersion, set))
        d.Manifests.Manifests.set(F.OlderVersion, F.Manifest(F.OlderVersion))
        d.Assets.PutAll(set)
        fx = await ConsoleInstallFixture.Create({ descriptors: d.Delivery })
        await D.Installed(fx)
        const [configMap] = D.DescriptorApplies(fx)
        assert.deepEqual(configMap?.data, ReleaseDescriptorsConfigMap.DataOf(set))
        assert.equal(configMap?.metadata.annotations?.[ReleaseDescriptorsConfigMap.ReleaseAnnotation], F.OlderVersion)
    })

    it('is re-applied on every install, each time with the descriptors of the release the install starts on', async () =>
    {
        const d = D.WithRelease(F.OlderVersion, F.OlderMarker)
        d.Add(F.Version, F.NewerMarker)
        fx = await ConsoleInstallFixture.Create({ descriptors: d.Delivery })
        fx.Installer.Start(D.Hive)
        // A release imported while the install runs does not change what it delivers.
        d.Release.Set(F.Version)
        await fx.Installer.WhenSettled(D.Hive)
        await D.Installed(fx)
        await D.Installed(fx)
        const applies = D.DescriptorApplies(fx)
        assert.deepEqual(applies.map(a => a.metadata.annotations?.[ReleaseDescriptorsConfigMap.ReleaseAnnotation]), [F.OlderVersion, F.Version, F.Version])
        assert.deepEqual(applies.map(a => a.data), [F.OlderVersion, F.Version, F.Version].map(v => ReleaseDescriptorsConfigMap.DataOf(d.Artifact.Sets.get(v) as NonNullable<ReturnType<typeof d.Artifact.Sets.get>>)))
    })

    it('refuses to start when the console\'s images come from different releases', async () =>
    {
        const d = D.WithRelease()
        d.Release.Versions.set(ReleaseApp.TenantIdp, F.OlderVersion)
        fx = await ConsoleInstallFixture.Create({ descriptors: d.Delivery })
        assert.throws(() => fx.Installer.Start(D.Hive), (err: unknown) => err instanceof ConsoleInstallUnavailableError && D.MixedPattern.test(err.message))
        assert.equal(fx.Installer.StatusFor(D.Hive), undefined)
    })

    it('descriptors the release does not sign fail the install at reading-release-descriptors, named, before anything is applied', async () =>
    {
        const d = D.WithRelease()
        d.Artifact.Sets.set(F.Version, F.Set(F.ForgedMarker))
        fx = await ConsoleInstallFixture.Create({ descriptors: d.Delivery })
        fx.Installer.Start(D.Hive)
        const status = await fx.Installer.WhenSettled(D.Hive)
        assert.equal(status?.state, ConsoleInstallState.Failed)
        assert.equal(status?.step, ConsoleInstallStep.ReadingReleaseDescriptors)
        assert.ok(status?.error?.includes(D.MismatchText), status?.error)
        assert.deepEqual(fx.Kubectl.Applied, [])
        assert.deepEqual(fx.Kubectl.ServerApplied, [])
    })

    it('a registry that cannot be reached fails the install at reading-release-descriptors with that sentence, before anything is applied', async () =>
    {
        const d = D.WithRelease()
        d.Artifact.Error = new OciUnavailableError(D.RegistryDown)
        fx = await ConsoleInstallFixture.Create({ descriptors: d.Delivery })
        fx.Installer.Start(D.Hive)
        const status = await fx.Installer.WhenSettled(D.Hive)
        assert.equal(status?.step, ConsoleInstallStep.ReadingReleaseDescriptors)
        assert.ok(status?.error?.startsWith(D.ReadingFailedText), status?.error)
        assert.ok(status?.error?.includes(D.RegistryDownText), status?.error)
        assert.deepEqual(fx.Kubectl.Applied, [])
    })

    it('a cluster whose descriptors ConfigMap belongs to another hive is refused before anything is applied, and left as it is', async () =>
    {
        fx = await ConsoleInstallFixture.Create({ descriptors: D.WithRelease().Delivery })
        D.PutDescriptors(fx, D.OtherHive)
        fx.Installer.Start(D.Hive)
        const status = await fx.Installer.WhenSettled(D.Hive)
        assert.equal(status?.state, ConsoleInstallState.Failed)
        assert.equal(status?.step, ConsoleInstallStep.ReadingReleaseDescriptors)
        assert.ok(status?.error?.includes(D.HeldText), status?.error)
        assert.deepEqual(fx.Kubectl.Applied, [])
        assert.ok(!D.DeletedDescriptors(fx))
    })

    it('an object no install wrote (no hive label) is deleted before the apply, so none of its keys survive', async () =>
    {
        // The fake replaces whole objects on apply; this proves the delete-first path, not server-side field pruning.
        fx = await ConsoleInstallFixture.Create({ descriptors: D.WithRelease().Delivery })
        D.PutDescriptors(fx, undefined)
        await D.Installed(fx)
        const deleteAt = D.IndexOf(fx, D.DeleteManifestCall, c => c[1] === ReleaseDescriptorsConfigMap.IdentityManifest())
        assert.ok(deleteAt >= 0)
        assert.ok(deleteAt < D.IndexOf(fx, D.RolloutRestartCall))
        const applied = D.DescriptorApplies(fx)
        assert.equal(applied.length, 1)
        assert.equal((applied[0]?.metadata as { resourceVersion?: string }).resourceVersion, undefined)
    })

    it('replaces this hive\'s object only at the resourceVersion read just before the apply (a write in between fails the apply)', async () =>
    {
        fx = await ConsoleInstallFixture.Create({ descriptors: D.WithRelease().Delivery })
        D.PutDescriptors(fx, D.Hive)
        await D.Installed(fx)
        const [applied] = D.DescriptorApplies(fx)
        assert.equal((applied?.metadata as { resourceVersion?: string }).resourceVersion, D.ResourceVersion)
    })

    it('an object another hive took over while the install ran is not overwritten: the install fails before the restarts', async () =>
    {
        fx = await ConsoleInstallFixture.Create({ descriptors: D.WithRelease().Delivery })
        // Free when the descriptors are read; another hive's when they are delivered.
        D.QueueDescriptors(fx, [undefined, JSON.stringify(D.DescriptorsObject(D.OtherHive))])
        fx.Installer.Start(D.Hive)
        const status = await fx.Installer.WhenSettled(D.Hive)
        assert.equal(status?.state, ConsoleInstallState.Failed)
        assert.ok(status?.error?.includes(D.HeldText), status?.error)
        assert.deepEqual(D.DescriptorApplies(fx), [])
        assert.equal(D.IndexOf(fx, D.RolloutRestartCall), -1)
    })

    it('a removal does not delete an object another hive took over after the install read it', async () =>
    {
        fx = await ConsoleInstallFixture.Create()
        // This hive's when the install starts; another hive's when the nothing-to-deliver removal reads it again.
        D.QueueDescriptors(fx, [JSON.stringify(D.DescriptorsObject(D.Hive)), JSON.stringify(D.DescriptorsObject(D.OtherHive))])
        await D.Installed(fx)
        assert.ok(!D.DeletedDescriptors(fx))
    })

    it('with nothing to deliver (no release, or one that signs no digests) it removes this hive\'s earlier ConfigMap', async () =>
    {
        fx = await ConsoleInstallFixture.Create()
        D.PutDescriptors(fx, D.Hive)
        await D.Installed(fx)
        assert.ok(D.DeletedDescriptors(fx))
        fx.Dispose()

        const d = new DescriptorInstall()
        d.Records.Records.push(F.Record(F.Version, undefined))
        fx = await ConsoleInstallFixture.Create({ descriptors: d.Delivery })
        D.PutDescriptors(fx, D.Hive)
        await D.Installed(fx)
        assert.ok(D.DeletedDescriptors(fx))
        assert.deepEqual(D.DescriptorApplies(fx), [])
        fx.Dispose()

        // An object no install wrote is left alone when there is nothing to deliver.
        fx = await ConsoleInstallFixture.Create()
        D.PutDescriptors(fx, undefined)
        await D.Installed(fx)
        assert.ok(!D.DeletedDescriptors(fx))
    })

    it('removing the console removes this hive\'s descriptors ConfigMap, and leaves another hive\'s', async () =>
    {
        fx = await ConsoleInstallFixture.Create()
        D.PutDescriptors(fx, D.Hive)
        await fx.Installer.Uninstall(fx.Hives.get(D.Hive) as HiveRecord)
        assert.ok(D.DeletedDescriptors(fx))
        fx.Dispose()
        fx = await ConsoleInstallFixture.Create()
        D.PutDescriptors(fx, D.OtherHive)
        await fx.Installer.Uninstall(fx.Hives.get(D.Hive) as HiveRecord)
        assert.ok(!D.DeletedDescriptors(fx))
    })

    it('applies the console Deployment, its configuration objects, Role and RoleBinding as the 0.18 builder renders them', async () =>
    {
        fx = await ConsoleInstallFixture.Create()
        await D.Installed(fx)
        // Client-side and server-side (the empty configuration objects go server-side, so no client-side apply clears their data).
        const items = [...fx.Kubectl.Applied, ...fx.Kubectl.ServerApplied].flatMap(m => D.Items(m))
        const system = K8sManifestBuilder.SystemNamespace
        const idp = K8sManifestBuilder.IdpNameOf(D.Tenant)
        const admin = K8sManifestBuilder.TenantAdminNameOf(D.Tenant)
        const M = ComponentConfigurationMounts

        // The console Deployment: component labels (on it and its pod template), Recreate (its data volume has one writer), its
        // configuration volumes and mounts, and the release descriptors ConfigMap mounted read-only at /etc/pragmatic/descriptors.
        const deployment = D.Find(items, D.DeploymentKind, system, admin)
        const container = M.ContainerOf(deployment.metadata.labels, ReleaseApp.TenantAdmin) as string
        const labels = M.Labels([{ Container: container, Component: ReleaseApp.TenantAdmin }])
        const spec = deployment.spec as unknown as DeploymentSpec
        assert.deepEqual({ ...deployment.metadata.labels, ...labels }, deployment.metadata.labels)
        assert.deepEqual({ ...spec.template.metadata.labels, ...labels }, spec.template.metadata.labels)
        assert.equal(labels[M.ManagedByLabel], M.ManagedBy)
        assert.deepEqual(spec.strategy, D.RecreateStrategy)
        assert.deepEqual(spec.template.spec.volumes.filter(v => M.Volumes(ReleaseApp.TenantAdmin).some(e => JSON.stringify(e) === JSON.stringify(v))), M.Volumes(ReleaseApp.TenantAdmin))
        assert.ok(spec.template.spec.volumes.some(v => JSON.stringify(v) === JSON.stringify({ name: D.DescriptorsVolume, configMap: { name: ReleaseDescriptorsConfigMap.Name, optional: true } })))
        const mounts = spec.template.spec.containers.find(c => c.name === container)?.volumeMounts ?? []
        assert.ok(mounts.some(m => JSON.stringify(m) === JSON.stringify({ name: D.DescriptorsVolume, mountPath: M.ReleaseDescriptorsMount, readOnly: true })))
        for (const mount of M.Mounts(ReleaseApp.TenantAdmin))
        {
            assert.ok(mounts.some(m => JSON.stringify(m) === JSON.stringify(mount)), JSON.stringify(mount))
        }

        // The IdP Deployment is a configuration target too.
        const idpDeployment = D.Find(items, D.DeploymentKind, idp, idp)
        assert.ok(M.ContainerOf(idpDeployment.metadata.labels, ReleaseApp.TenantIdp) !== undefined)

        // The empty configuration objects the console writes by name (it never creates beside them).
        for (const [namespace, component] of [[system, ReleaseApp.TenantAdmin], [idp, ReleaseApp.TenantIdp]] as const)
        {
            D.Find(items, D.ConfigMapKind, namespace, M.ConfigMapNameOf(component))
            const secret = D.Find(items, D.SecretKind, namespace, M.SecretNameOf(component))
            assert.equal(secret.data, undefined)
            assert.equal(secret.stringData, undefined)
        }

        // The configuration Role and RoleBinding in pragmatic-system (the hive agent and the console) and the IdP namespace.
        const role = K8sManifestBuilder.TenantConsoleConfigurationRoleNameOf(D.Tenant)
        const rules = (components: string[], deployments: string[]): unknown[] => [
            { apiGroups: [''], resources: ['configmaps'], verbs: D.ByName, resourceNames: components.map(c => M.ConfigMapNameOf(c)) },
            { apiGroups: [''], resources: ['secrets'], verbs: D.ByName, resourceNames: components.map(c => M.SecretNameOf(c)) },
            { apiGroups: ['apps'], resources: ['deployments'], verbs: D.ByName, resourceNames: deployments },
        ]
        assert.deepEqual(D.Find(items, D.RoleKind, system, role).rules,
            rules([ReleaseApp.HiveAgent, ReleaseApp.TenantAdmin], [K8sManifestBuilder.HiveAgentNameOf(D.Hive), admin]))
        assert.deepEqual(D.Find(items, D.RoleKind, idp, role).rules, rules([ReleaseApp.TenantIdp], [idp]))
        for (const namespace of [system, idp])
        {
            const binding = D.Find(items, D.RoleBindingKind, namespace, role)
            assert.deepEqual(binding.subjects, [{ kind: D.ServiceAccountKind, name: admin, namespace: system }])
            assert.deepEqual(binding.roleRef, { apiGroup: D.RbacGroup, kind: D.RoleKind, name: role })
        }
    })
})

/** A reinstall onto a release whose realm sign-in service has another descriptor than the one its configuration was applied for. */
class PreparedInstall
{
    public static readonly Tenant = 'acme'
    public static readonly Idp = K8sManifestBuilder.IdpNameOf('acme')
    public static readonly ConfigResource = 'configmap/' + AppliedConfigurationKeys.ObjectNamePrefix + ReleaseApp.TenantIdp
    public static readonly OldDigest = `sha256:${'0'.repeat(64)}`
    public static readonly RefusedSetting = 'core.databaseUrl'
    public static readonly RefusedRule = '/options/core/databaseUrl is not a setting of this option'

    /** The digest of the release's tenant-idp descriptor (what the new pods will carry). */
    public static ReleaseDigest(d: DescriptorInstall): string
    {
        return (d.Artifact.Sets.get(F.Version)?.Get(ReleaseApp.TenantIdp) as NonNullable<ReturnType<ComponentDescriptorSet['Get']>>).ContentDigest()
    }

    /** The configuration applied for the old descriptor, as the ConfigMap holds it. */
    public static Applied(): AppliedConfiguration
    {
        return new AppliedConfiguration(PreparedInstall.Tenant, ReleaseApp.TenantIdp, 3, '0.2.0', PreparedInstall.OldDigest, { options: { local: { maxAttempts: 5 } } })
    }

    public static Waiting(): string
    {
        return JSON.stringify(AppliedConfigurationCodec.ToConfigMap(PreparedInstall.Applied(), PreparedInstall.Idp))
    }

    public static Prepared(digest: string): string
    {
        const P = PreparedInstall
        const applied = P.Applied()
        const entry = new AppliedConfiguration(P.Tenant, ReleaseApp.TenantIdp, 1, F.ComponentVersion, digest, { options: { local: { maxAttempts: 5 } } })
        const map = AppliedConfigurationEntries.With(AppliedConfigurationCodec.ToConfigMap(applied, P.Idp), entry)
        map.metadata.annotations = ConfigurationPreparationStatus.Of(map.metadata.annotations).DerivedFrom(applied.ContentHash()).WithPrepared(digest).Over(map.metadata.annotations)
        return JSON.stringify(map)
    }

    public static Refused(digest: string): string
    {
        const P = PreparedInstall
        const applied = P.Applied()
        const map = AppliedConfigurationCodec.ToConfigMap(applied, P.Idp)
        const refusal = new ConfigurationPreparationRefusal(digest, F.ComponentVersion, [P.RefusedSetting], P.RefusedRule)
        map.metadata.annotations = ConfigurationPreparationStatus.Of(map.metadata.annotations).DerivedFrom(applied.ContentHash()).WithRefusal(refusal).Over(map.metadata.annotations)
        return JSON.stringify(map)
    }

    /** A running IdP Deployment (an earlier release's) and its configuration answering `answers` in turn, then `last`. */
    public static Cluster(fx: ConsoleInstallFixture, answers: Array<string | undefined>, last: string | undefined): void
    {
        const P = PreparedInstall
        fx.Kubectl.Put(P.Idp, 'deployment/' + P.Idp, { kind: 'Deployment', metadata: { name: P.Idp, namespace: P.Idp } })
        if (last !== undefined) fx.Kubectl.Objects.set(ConsoleFakeKubectl.Key(P.Idp, P.ConfigResource), last)
        fx.Kubectl.FindAnswers.set(ConsoleFakeKubectl.Key(P.Idp, P.ConfigResource), answers)
    }

    public static IsIdpDeployment(item: K8sItem): boolean
    {
        return item.kind === DescriptorInstall.DeploymentKind && item.metadata.namespace === PreparedInstall.Idp && item.metadata.name === PreparedInstall.Idp
    }

    /** The positions (in Calls) of each client-side Apply carrying the IdP Deployment with a pod template. */
    public static IdpDeploymentApplies(fx: ConsoleInstallFixture): number[]
    {
        const applies = fx.Kubectl.Calls.map((c, i) => [c[0], i] as const).filter(([verb]) => verb === DescriptorInstall.ApplyCall).map(([, i]) => i)
        return applies.filter((_, n) => DescriptorInstall.Items(fx.Kubectl.Applied[n] as string).some(i => PreparedInstall.IsIdpDeployment(i) && (i as unknown as { spec?: unknown }).spec !== undefined))
    }
}

describe('TenantConsoleInstaller: configurations prepared before the IdP rolls', () =>
{
    const D = DescriptorInstall
    const P = PreparedInstall
    let fx: ConsoleInstallFixture

    afterEach(() =>
    {
        fx?.Dispose()
    })

    it('rolls the console first, waits until it prepared the IdP configuration for the release, and only then applies the IdP image', async () =>
    {
        const d = D.WithRelease()
        fx = await ConsoleInstallFixture.Create({ descriptors: d.Delivery })
        P.Cluster(fx, [P.Waiting(), P.Waiting()], P.Prepared(P.ReleaseDigest(d)))
        await D.Installed(fx)
        const calls = fx.Kubectl.Calls
        const admin = K8sManifestBuilder.TenantAdminNameOf(P.Tenant)
        const consoleReady = calls.findIndex(c => c[0] === 'RolloutStatus' && c[2] === admin)
        const lastConfigRead = calls.map((c, i) => [c, i] as const).filter(([c]) => c[0] === 'Find' && c[2] === P.ConfigResource).map(([, i]) => i).pop() ?? -1
        const [idpApply] = P.IdpDeploymentApplies(fx)
        assert.ok(idpApply !== undefined, 'the IdP Deployment is applied')
        assert.ok(calls.findIndex(c => c[0] === 'RolloutRestart' && c[2] === admin) < consoleReady)
        assert.ok(consoleReady < lastConfigRead, 'the configuration is read after the console is ready')
        assert.ok(lastConfigRead < idpApply, 'the IdP image is applied only after the configuration was prepared')
        assert.ok(idpApply < calls.findIndex(c => c[0] === 'RolloutRestart' && c[1] === P.Idp))
        assert.ok(calls.findIndex(c => c[0] === 'RolloutRestart' && c[1] === P.Idp) < calls.findIndex(c => c[0] === 'RolloutStatus' && c[1] === P.Idp))
        // The first apply carries no IdP pod template; the IdP's labels go on by themselves (the console finds its target by them).
        const first = D.Items(fx.Kubectl.Applied[0] as string)
        assert.equal(first.some(i => P.IsIdpDeployment(i)), false)
        const labelled = fx.Kubectl.ServerApplied.flatMap(m => D.Items(m)).find(i => P.IsIdpDeployment(i))
        assert.ok(labelled !== undefined)
        assert.equal((labelled as unknown as { spec?: unknown }).spec, undefined, 'labels only: nothing rolls')
        assert.equal(labelled.metadata.labels?.[ComponentConfigurationMounts.ManagedByLabel], ComponentConfigurationMounts.ManagedBy)
        assert.ok(calls.indexOf(calls.find(c => c[0] === 'ApplyServerSide') as string[]) < consoleReady)
    })

    it('a refusal stops the install at preparing-configuration naming the settings, before the IdP is touched', async () =>
    {
        const d = D.WithRelease()
        fx = await ConsoleInstallFixture.Create({ descriptors: d.Delivery })
        P.Cluster(fx, [], P.Refused(P.ReleaseDigest(d)))
        fx.Installer.Start(D.Hive)
        const status = await fx.Installer.WhenSettled(D.Hive)
        assert.equal(status?.state, ConsoleInstallState.Failed)
        assert.equal(status?.step, ConsoleInstallStep.PreparingConfiguration)
        assert.match(status?.error ?? '', new RegExp(P.RefusedSetting.replace('.', '\\.')))
        assert.match(status?.error ?? '', /identity provider was not changed/)
        assert.deepEqual(P.IdpDeploymentApplies(fx), [])
        assert.equal(fx.Kubectl.Calls.some(c => (c[0] === 'RolloutRestart' || c[0] === 'RolloutStatus') && c[1] === P.Idp), false)
    })

    it('a console that never prepares stops the install with a bounded wait, the IdP untouched', async () =>
    {
        const d = D.WithRelease()
        fx = await ConsoleInstallFixture.Create({ descriptors: d.Delivery })
        P.Cluster(fx, [], P.Waiting())
        fx.Installer.Start(D.Hive)
        const status = await fx.Installer.WhenSettled(D.Hive)
        assert.equal(status?.step, ConsoleInstallStep.PreparingConfiguration)
        assert.match(status?.error ?? '', /did not prepare/)
        const reads = fx.Kubectl.Calls.filter(c => c[0] === 'Find' && c[2] === P.ConfigResource).length
        assert.equal(reads, TenantConsoleInstaller.PreparationTimeoutMs / TenantConsoleInstaller.PreparationPollMs + 1)
        assert.deepEqual(P.IdpDeploymentApplies(fx), [])
    })

    it('an unconfigured IdP, or one already configured for the release descriptor, needs no wait', async () =>
    {
        const d = D.WithRelease()
        fx = await ConsoleInstallFixture.Create({ descriptors: d.Delivery })
        P.Cluster(fx, [], JSON.stringify({ kind: 'ConfigMap', metadata: { name: 'pragmatic-config-pragmatic-tenant-idp' } }))
        await D.Installed(fx)
        assert.equal(fx.Kubectl.Calls.filter(c => c[0] === 'Find' && c[2] === P.ConfigResource).length, 1)
        fx.Dispose()
        fx = await ConsoleInstallFixture.Create({ descriptors: d.Delivery })
        const current = new AppliedConfiguration(P.Tenant, ReleaseApp.TenantIdp, 4, F.ComponentVersion, P.ReleaseDigest(d), { options: {} })
        P.Cluster(fx, [], JSON.stringify(AppliedConfigurationCodec.ToConfigMap(current, P.Idp)))
        await D.Installed(fx)
    })

    it('the empty configuration objects are applied server-side, never in the client-side apply that would clear what a client-side apply wrote', async () =>
    {
        const d = D.WithRelease()
        fx = await ConsoleInstallFixture.Create({ descriptors: d.Delivery })
        await D.Installed(fx)
        const isConfigurationObject = (i: K8sItem): boolean => i.metadata.name.startsWith(AppliedConfigurationKeys.ObjectNamePrefix) || i.metadata.name.startsWith(ComponentConfigurationMounts.SecretNamePrefix)
        assert.equal(fx.Kubectl.Applied.flatMap(m => D.Items(m)).some(isConfigurationObject), false)
        const server = fx.Kubectl.ServerApplied.flatMap(m => D.Items(m)).filter(isConfigurationObject)
        assert.ok(server.some(i => i.metadata.namespace === P.Idp && i.metadata.name === AppliedConfigurationKeys.ObjectNamePrefix + ReleaseApp.TenantIdp))
        assert.ok(server.every(i => (i as unknown as { data?: unknown }).data === undefined))
    })
})
