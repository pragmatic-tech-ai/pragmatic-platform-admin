import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { OciUnavailableError, ReleaseApp } from '@pragmatic-tech-ai/pragmatic-release-toolkit'
import { ComponentConfigurationMounts, K8sManifestBuilder, type HiveRecord } from '@pragmatic-tech-ai/pragmatic-tenant-plane'
import { ConsoleReleaseDescriptors } from '../console-release-descriptors.js'
import type { IPlatformRelease } from '../platform-images.js'
import { ReleaseDescriptorSource } from '../release/release-descriptor-source.js'
import { ReleaseDescriptorsConfigMap } from '../release-descriptors-config-map.js'
import { ConsoleInstallState, ConsoleInstallStep, ConsoleInstallUnavailableError } from '../tenant-console-installer.js'
import { ConsoleInstallFixture } from './console-install-fakes.js'
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
        return DescriptorInstall.Items(manifestJson).some(i => i.kind === 'ConfigMap' && i.metadata.name === ReleaseDescriptorsConfigMap.Name)
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
        const metadata = hiveId === undefined ? { name: ReleaseDescriptorsConfigMap.Name } : { name: ReleaseDescriptorsConfigMap.Name, labels: K8sManifestBuilder.HiveLabelsOf(hiveId) }
        fx.Kubectl.Put(ReleaseDescriptorsConfigMap.Namespace, ReleaseDescriptorsConfigMap.Resource(), { kind: 'ConfigMap', metadata })
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
        const at = fx.Kubectl.Calls.map(c => c[0]).lastIndexOf('ApplyServerSide')
        assert.ok(D.IndexOf(fx, 'Apply') < at)
        assert.ok(at < D.IndexOf(fx, 'RolloutRestart'))
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
        assert.throws(() => fx.Installer.Start(D.Hive), (err: unknown) => err instanceof ConsoleInstallUnavailableError && /different platform releases/.test(err.message))
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
        assert.ok(status?.error?.startsWith("Could not read the release's component descriptors."), status?.error)
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
        const deleteAt = D.IndexOf(fx, 'DeleteManifest', c => c[1] === ReleaseDescriptorsConfigMap.IdentityManifest())
        assert.ok(deleteAt >= 0)
        assert.ok(deleteAt < D.IndexOf(fx, 'RolloutRestart'))
        assert.equal(D.DescriptorApplies(fx).length, 1)
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
        const items = fx.Kubectl.Applied.flatMap(m => D.Items(m))
        const system = K8sManifestBuilder.SystemNamespace
        const idp = K8sManifestBuilder.IdpNameOf(D.Tenant)
        const admin = K8sManifestBuilder.TenantAdminNameOf(D.Tenant)
        const M = ComponentConfigurationMounts

        // The console Deployment: component labels (on it and its pod template), Recreate (its data volume has one writer), its
        // configuration volumes and mounts, and the release descriptors ConfigMap mounted read-only at /etc/pragmatic/descriptors.
        const deployment = D.Find(items, 'Deployment', system, admin)
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
        const idpDeployment = D.Find(items, 'Deployment', idp, idp)
        assert.ok(M.ContainerOf(idpDeployment.metadata.labels, ReleaseApp.TenantIdp) !== undefined)

        // The empty configuration objects the console writes by name (it never creates beside them).
        for (const [namespace, component] of [[system, ReleaseApp.TenantAdmin], [idp, ReleaseApp.TenantIdp]] as const)
        {
            D.Find(items, 'ConfigMap', namespace, M.ConfigMapNameOf(component))
            const secret = D.Find(items, 'Secret', namespace, M.SecretNameOf(component))
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
        assert.deepEqual(D.Find(items, 'Role', system, role).rules,
            rules([ReleaseApp.HiveAgent, ReleaseApp.TenantAdmin], [K8sManifestBuilder.HiveAgentNameOf(D.Hive), admin]))
        assert.deepEqual(D.Find(items, 'Role', idp, role).rules, rules([ReleaseApp.TenantIdp], [idp]))
        for (const namespace of [system, idp])
        {
            const binding = D.Find(items, 'RoleBinding', namespace, role)
            assert.deepEqual(binding.subjects, [{ kind: 'ServiceAccount', name: admin, namespace: system }])
            assert.deepEqual(binding.roleRef, { apiGroup: D.RbacGroup, kind: 'Role', name: role })
        }
    })
})
