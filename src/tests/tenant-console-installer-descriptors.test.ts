import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { ReleaseApp } from '@pragmatic-tech-ai/pragmatic-release-toolkit'
import { ComponentConfigurationMounts, K8sManifestBuilder, type HiveRecord } from '@pragmatic-tech-ai/pragmatic-tenant-plane'
import { ConsoleReleaseDescriptors } from '../console-release-descriptors.js'
import type { IPlatformRelease } from '../platform-images.js'
import { ReleaseDescriptorSource } from '../release/release-descriptor-source.js'
import { ReleaseDescriptorsConfigMap } from '../release-descriptors-config-map.js'
import { ConsoleInstallState, ConsoleInstallStep } from '../tenant-console-installer.js'
import { ConsoleInstallFixture } from './console-install-fakes.js'
import { FakeAssets, FakeComponentsArtifact, FakeManifestSource, FakeReleaseRecords, ReleaseDescriptorFixtures as F } from './release-descriptor-fixtures.js'

type K8sItem = {
    apiVersion: string; kind: string
    metadata: { name: string; namespace?: string; labels?: Record<string, string>; annotations?: Record<string, string> }
    spec?: Record<string, unknown>; rules?: unknown[]; subjects?: unknown[]; roleRef?: unknown; data?: Record<string, string>
}
type PodSpec = { containers: Array<{ name: string; volumeMounts?: unknown[] }>; initContainers?: Array<{ name: string }>; volumes: unknown[] }
type DeploymentSpec = { strategy: unknown; template: { metadata: { labels: Record<string, string> }; spec: PodSpec } }

/** The release the console's images come from, settable by a test. */
class FakePlatformRelease implements IPlatformRelease
{
    public Version: string | undefined = F.Version

    public ReleaseOf(app: ReleaseApp): string | undefined
    {
        return app === ReleaseApp.TenantAdmin ? this.Version : undefined
    }
}

/** A console install fixture whose installer delivers descriptors through the real source over fake registry / GitHub reads. */
class DescriptorInstall
{
    public readonly Release = new FakePlatformRelease()
    public readonly Records = new FakeReleaseRecords()
    public readonly Artifact = new FakeComponentsArtifact()
    public readonly Manifests = new FakeManifestSource()
    public readonly Assets = new FakeAssets()
    public readonly Delivery = new ConsoleReleaseDescriptors(this.Release, new ReleaseDescriptorSource(this.Records, this.Artifact, this.Manifests, this.Assets))

    public static Items(manifestJson: string): K8sItem[]
    {
        const parsed = JSON.parse(manifestJson) as { kind: string; items?: K8sItem[] }
        return parsed.kind === 'List' ? parsed.items ?? [] : [parsed as unknown as K8sItem]
    }

    /** The descriptors ConfigMaps the installer applied server-side, in order. */
    public static DescriptorApplies(fx: ConsoleInstallFixture): K8sItem[]
    {
        return fx.Kubectl.ServerApplied.flatMap(m => DescriptorInstall.Items(m)).filter(i => i.kind === 'ConfigMap' && i.metadata.name === ReleaseDescriptorsConfigMap.Name)
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

    public static PutDescriptors(fx: ConsoleInstallFixture, hiveId: string): void
    {
        fx.Kubectl.Put(ReleaseDescriptorsConfigMap.Namespace, ReleaseDescriptorsConfigMap.Resource(), { kind: 'ConfigMap', metadata: { name: ReleaseDescriptorsConfigMap.Name, labels: K8sManifestBuilder.HiveLabelsOf(hiveId) } })
    }
}

describe('TenantConsoleInstaller: the release descriptors ConfigMap', () =>
{
    let fx: ConsoleInstallFixture

    afterEach(() =>
    {
        fx?.Dispose()
    })

    it('is built from the console\'s release components artifact and applied server-side before the console', async () =>
    {
        const d = new DescriptorInstall()
        const set = F.Set()
        d.Records.Records.push(F.Record(F.Version, set))
        d.Artifact.Sets.set(F.Version, set)
        fx = await ConsoleInstallFixture.Create({ descriptors: d.Delivery })
        fx.Installer.Start('h1')
        assert.equal((await fx.Installer.WhenSettled('h1'))?.state, ConsoleInstallState.Deployed)
        const [configMap] = DescriptorInstall.DescriptorApplies(fx)
        assert.ok(configMap !== undefined)
        assert.equal(configMap.metadata.namespace, K8sManifestBuilder.SystemNamespace)
        assert.equal(configMap.metadata.annotations?.[ReleaseDescriptorsConfigMap.ReleaseAnnotation], F.Version)
        assert.deepEqual(configMap.data, ReleaseDescriptorsConfigMap.DataOf(set))
        // Applied before the bootstrap (the console's Deployment), so its restarted pod mounts it.
        const calls = fx.Kubectl.Calls.map(c => c[0])
        const descriptorsAt = fx.Kubectl.ServerApplied.findIndex(m => DescriptorInstall.Items(m).some(i => i.metadata.name === ReleaseDescriptorsConfigMap.Name))
        assert.equal(descriptorsAt, 0)
        assert.ok(calls.indexOf('ApplyServerSide') < calls.indexOf('Apply'))
    })

    it('a release cut before the artifact delivers the component.json assets its manifest names', async () =>
    {
        const d = new DescriptorInstall()
        const set = F.Set('pre')
        d.Release.Version = F.OlderVersion
        d.Records.Records.push(F.Record(F.OlderVersion, set))
        d.Manifests.Manifests.set(F.OlderVersion, F.Manifest(F.OlderVersion))
        d.Assets.PutAll(set)
        fx = await ConsoleInstallFixture.Create({ descriptors: d.Delivery })
        fx.Installer.Start('h1')
        assert.equal((await fx.Installer.WhenSettled('h1'))?.state, ConsoleInstallState.Deployed)
        const [configMap] = DescriptorInstall.DescriptorApplies(fx)
        assert.deepEqual(configMap?.data, ReleaseDescriptorsConfigMap.DataOf(set))
        assert.equal(configMap?.metadata.annotations?.[ReleaseDescriptorsConfigMap.ReleaseAnnotation], F.OlderVersion)
    })

    it('is re-applied on every install, each time with the descriptors of the release the install starts on', async () =>
    {
        const d = new DescriptorInstall()
        const older = F.Set('older')
        const newer = F.Set('newer')
        d.Records.Records.push(F.Record(F.OlderVersion, older), F.Record(F.Version, newer))
        d.Artifact.Sets.set(F.OlderVersion, older)
        d.Artifact.Sets.set(F.Version, newer)
        d.Release.Version = F.OlderVersion
        fx = await ConsoleInstallFixture.Create({ descriptors: d.Delivery })
        fx.Installer.Start('h1')
        // A release imported while the install runs does not change what it delivers.
        d.Release.Version = F.Version
        await fx.Installer.WhenSettled('h1')
        fx.Installer.Start('h1')
        await fx.Installer.WhenSettled('h1')
        fx.Installer.Start('h1')
        await fx.Installer.WhenSettled('h1')
        const applies = DescriptorInstall.DescriptorApplies(fx)
        assert.deepEqual(applies.map(a => a.metadata.annotations?.[ReleaseDescriptorsConfigMap.ReleaseAnnotation]), [F.OlderVersion, F.Version, F.Version])
        assert.deepEqual(applies.map(a => a.data), [ReleaseDescriptorsConfigMap.DataOf(older), ReleaseDescriptorsConfigMap.DataOf(newer), ReleaseDescriptorsConfigMap.DataOf(newer)])
    })

    it('descriptors the release does not sign fail the install at preparing-certificates, named, before anything is applied', async () =>
    {
        const d = new DescriptorInstall()
        d.Records.Records.push(F.Record(F.Version, F.Set()))
        d.Artifact.Sets.set(F.Version, F.Set('forged'))
        fx = await ConsoleInstallFixture.Create({ descriptors: d.Delivery })
        fx.Installer.Start('h1')
        const status = await fx.Installer.WhenSettled('h1')
        assert.equal(status?.state, ConsoleInstallState.Failed)
        assert.equal(status?.step, ConsoleInstallStep.PreparingCertificates)
        assert.ok(status?.error?.includes('The release carries a component descriptor its signature does not bind: '), status?.error)
        assert.deepEqual(fx.Kubectl.Applied, [])
        assert.deepEqual(DescriptorInstall.DescriptorApplies(fx), [])
    })

    it('with nothing to deliver (no release, or one that signs no digests) it removes this hive\'s earlier ConfigMap, never another hive\'s', async () =>
    {
        fx = await ConsoleInstallFixture.Create()
        DescriptorInstall.PutDescriptors(fx, 'h1')
        fx.Installer.Start('h1')
        assert.equal((await fx.Installer.WhenSettled('h1'))?.state, ConsoleInstallState.Deployed)
        assert.ok(DescriptorInstall.DeletedDescriptors(fx))
        fx.Dispose()

        const d = new DescriptorInstall()
        d.Records.Records.push(F.Record(F.Version, undefined))
        fx = await ConsoleInstallFixture.Create({ descriptors: d.Delivery })
        DescriptorInstall.PutDescriptors(fx, 'other-hive')
        fx.Installer.Start('h1')
        assert.equal((await fx.Installer.WhenSettled('h1'))?.state, ConsoleInstallState.Deployed)
        assert.ok(!DescriptorInstall.DeletedDescriptors(fx))
        assert.deepEqual(DescriptorInstall.DescriptorApplies(fx), [])
    })

    it('removing the console removes this hive\'s descriptors ConfigMap, and leaves another hive\'s', async () =>
    {
        fx = await ConsoleInstallFixture.Create()
        DescriptorInstall.PutDescriptors(fx, 'h1')
        await fx.Installer.Uninstall(fx.Hives.get('h1') as HiveRecord)
        assert.ok(DescriptorInstall.DeletedDescriptors(fx))
        fx.Dispose()
        fx = await ConsoleInstallFixture.Create()
        DescriptorInstall.PutDescriptors(fx, 'other-hive')
        await fx.Installer.Uninstall(fx.Hives.get('h1') as HiveRecord)
        assert.ok(!DescriptorInstall.DeletedDescriptors(fx))
    })

    it('applies the console Deployment, its configuration objects, Role and RoleBinding as the 0.18 builder renders them', async () =>
    {
        fx = await ConsoleInstallFixture.Create()
        fx.Installer.Start('h1')
        assert.equal((await fx.Installer.WhenSettled('h1'))?.state, ConsoleInstallState.Deployed)
        const items = fx.Kubectl.Applied.flatMap(m => DescriptorInstall.Items(m))
        const system = K8sManifestBuilder.SystemNamespace
        const idp = K8sManifestBuilder.IdpNameOf('acme')
        const admin = K8sManifestBuilder.TenantAdminNameOf('acme')
        const M = ComponentConfigurationMounts

        // The console Deployment: component labels (on it and its pod template), Recreate (its data volume has one writer), its
        // configuration volumes and mounts, and the release descriptors ConfigMap mounted read-only at /etc/pragmatic/descriptors.
        const deployment = DescriptorInstall.Find(items, 'Deployment', system, admin)
        const container = M.ContainerOf(deployment.metadata.labels, ReleaseApp.TenantAdmin) as string
        const labels = M.Labels([{ Container: container, Component: ReleaseApp.TenantAdmin }])
        const spec = deployment.spec as unknown as DeploymentSpec
        assert.deepEqual({ ...deployment.metadata.labels, ...labels }, deployment.metadata.labels)
        assert.deepEqual({ ...spec.template.metadata.labels, ...labels }, spec.template.metadata.labels)
        assert.equal(labels[M.ManagedByLabel], M.ManagedBy)
        assert.deepEqual(spec.strategy, { type: 'Recreate' })
        assert.deepEqual(spec.template.spec.volumes.filter(v => M.Volumes(ReleaseApp.TenantAdmin).some(e => JSON.stringify(e) === JSON.stringify(v))), M.Volumes(ReleaseApp.TenantAdmin))
        assert.ok(spec.template.spec.volumes.some(v => JSON.stringify(v) === JSON.stringify({ name: 'release-descriptors', configMap: { name: 'pragmatic-release-descriptors', optional: true } })))
        const mounts = spec.template.spec.containers.find(c => c.name === container)?.volumeMounts ?? []
        assert.ok(mounts.some(m => JSON.stringify(m) === JSON.stringify({ name: 'release-descriptors', mountPath: M.ReleaseDescriptorsMount, readOnly: true })))
        for (const mount of M.Mounts(ReleaseApp.TenantAdmin))
        {
            assert.ok(mounts.some(m => JSON.stringify(m) === JSON.stringify(mount)), JSON.stringify(mount))
        }

        // The IdP Deployment is a configuration target too.
        const idpDeployment = DescriptorInstall.Find(items, 'Deployment', idp, idp)
        assert.ok(M.ContainerOf(idpDeployment.metadata.labels, ReleaseApp.TenantIdp) !== undefined)

        // The empty configuration objects the console writes by name (it never creates beside them).
        for (const [namespace, component] of [[system, ReleaseApp.TenantAdmin], [idp, ReleaseApp.TenantIdp]] as const)
        {
            DescriptorInstall.Find(items, 'ConfigMap', namespace, M.ConfigMapNameOf(component))
            assert.equal(DescriptorInstall.Find(items, 'Secret', namespace, M.SecretNameOf(component)).data, undefined)
        }

        // The configuration Role and RoleBinding in pragmatic-system (the hive agent and the console) and the IdP namespace.
        const role = K8sManifestBuilder.TenantConsoleConfigurationRoleNameOf('acme')
        const byName = ['get', 'patch']
        const rules = (components: string[], deployments: string[]): unknown[] => [
            { apiGroups: [''], resources: ['configmaps'], verbs: byName, resourceNames: components.map(c => M.ConfigMapNameOf(c)) },
            { apiGroups: [''], resources: ['secrets'], verbs: byName, resourceNames: components.map(c => M.SecretNameOf(c)) },
            { apiGroups: ['apps'], resources: ['deployments'], verbs: byName, resourceNames: deployments },
        ]
        assert.deepEqual(DescriptorInstall.Find(items, 'Role', system, role).rules,
            rules([ReleaseApp.HiveAgent, ReleaseApp.TenantAdmin], [K8sManifestBuilder.HiveAgentNameOf('h1'), admin]))
        assert.deepEqual(DescriptorInstall.Find(items, 'Role', idp, role).rules, rules([ReleaseApp.TenantIdp], [idp]))
        for (const namespace of [system, idp])
        {
            const binding = DescriptorInstall.Find(items, 'RoleBinding', namespace, role)
            assert.deepEqual(binding.subjects, [{ kind: 'ServiceAccount', name: admin, namespace: system }])
            assert.deepEqual(binding.roleRef, { apiGroup: 'rbac.authorization.k8s.io', kind: 'Role', name: role })
        }
    })
})
