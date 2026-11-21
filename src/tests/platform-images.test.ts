import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EnvironmentWorkloadFactory, EnvStatus, EnvType, K8sManifestBuilder, ManifestRegistry, ReleaseState, Template, type EnvironmentRecord, type HiveRecord, type ManifestRecord } from '@pragmatic-tech-ai/pragmatic-tenant-plane'
import { DevPlatformImages, ReleasePlatformImages } from '../platform-images.js'
import { ReleaseApp, ReleaseApps } from '@pragmatic-tech-ai/pragmatic-release-toolkit'

class Releases
{
    public static readonly Host = 'ghcr.io'
    public static readonly Namespace = 'pragmatic-tech-ai/'
    public static readonly TempPrefix = 'platform-images-'
    public static readonly ManifestsFile = 'manifests.json'
    public static readonly PathSeparator = '/'
    public static readonly DigestSeparator = '@'
    public static readonly V1 = '0.1.0'
    public static readonly V3 = '0.3.0'
    public static readonly Day1 = '2026-11-01T00:00:00.000Z'
    public static readonly Day3 = '2026-11-03T00:00:00.000Z'
    public static readonly FillA = 'a'
    public static readonly FillC = 'c'

    public static Digest(fill: string): string
    {
        return 'sha256:' + fill.repeat(64)
    }

    public static Record(id: string, publishedAt: string, fill: string, extra: Partial<ManifestRecord> = {}, state: ReleaseState = ReleaseState.Verified): ManifestRecord
    {
        const images = {} as Record<ReleaseApp, { repository: string; digest: string }>
        for (const app of ReleaseApps.All)
        {
            images[app] = { repository: Releases.Namespace + app, digest: Releases.Digest(fill) }
        }
        return { id, image: '', publishedAt, release: { state, images }, ...extra }
    }

    public static AgentRef(fill: string): string
    {
        return Releases.Host + Releases.PathSeparator + Releases.Namespace + ReleaseApp.HiveAgent + Releases.DigestSeparator + Releases.Digest(fill)
    }

    public static async With(records: ManifestRecord[], body: (images: ReleasePlatformImages) => void): Promise<void>
    {
        const dir = await mkdtemp(join(tmpdir(), Releases.TempPrefix))
        try
        {
            const manifests = new ManifestRegistry(join(dir, Releases.ManifestsFile))
            await manifests.Load()
            for (const record of records)
            {
                await manifests.Put(record)
            }
            body(new ReleasePlatformImages(manifests, Releases.Host))
        }
        finally
        {
            await rm(dir, { recursive: true, force: true })
        }
    }
}

class DevImagesFx
{
    public static readonly AppDeployment = { appName: 'northwind', appVersion: '1.0.0', repo: 'apps/northwind', artifactTag: '1.0.0', manifestDigest: 'sha256:' + 'b'.repeat(64) } as unknown as NonNullable<EnvironmentRecord['appDeployment']>
}

describe('ReleasePlatformImages', () =>
{
    it('returns the by-digest hive-agent reference of the newest verified release', async () =>
    {
        await Releases.With([
            Releases.Record('0.1.0', '2026-11-01T00:00:00.000Z', 'a'),
            Releases.Record('0.2.0', '2026-11-02T00:00:00.000Z', 'b'),
        ], images => assert.equal(images.ImageOf(ReleaseApp.HiveAgent), Releases.AgentRef('b')))
    })

    it('skips a newer withdrawn release and a newer rejected one', async () =>
    {
        await Releases.With([
            Releases.Record('0.1.0', '2026-11-01T00:00:00.000Z', 'a'),
            Releases.Record('0.2.0', '2026-11-02T00:00:00.000Z', 'b', { withdrawn: true }),
            Releases.Record('0.3.0', '2026-11-03T00:00:00.000Z', 'c', {}, ReleaseState.Rejected),
            { id: 'local-1', image: 'registry/pragmatic-server:1', publishedAt: '2026-11-04T00:00:00.000Z' },
        ], images => assert.equal(images.ImageOf(ReleaseApp.HiveAgent), Releases.AgentRef('a')))
    })

    it('skips a newer verified release that has no image for the app', async () =>
    {
        const partial = Releases.Record(Releases.V3, Releases.Day3, Releases.FillC)
        delete (partial.release?.images as Partial<Record<ReleaseApp, unknown>>)[ReleaseApp.HiveAgent]
        await Releases.With([Releases.Record(Releases.V1, Releases.Day1, Releases.FillA), partial],
            images => assert.equal(images.ImageOf(ReleaseApp.HiveAgent), Releases.AgentRef(Releases.FillA)))
    })

    it('returns undefined with no records', async () =>
    {
        await Releases.With([], images => assert.equal(images.ImageOf(ReleaseApp.HiveAgent), undefined))
    })
})

describe('DevPlatformImages', () =>
{
    it('maps each release app to its own locally built dev image (the dev image builder of pragmatic-e2e tags them)', () =>
    {
        const images = new DevPlatformImages()
        const expected = new Map<ReleaseApp, string>([
            [ReleaseApp.PlatformAdmin, 'pragmatic-platform-admin:dev'],
            [ReleaseApp.PlatformEdge, 'pragmatic-platform-edge:dev'],
            [ReleaseApp.EnvServer, 'pragmatic-server:dev'],
            [ReleaseApp.EnvGateway, 'pragmatic-env-gateway:dev'],
            [ReleaseApp.HiveAgent, 'pragmatic-hive-agent:dev'],
            [ReleaseApp.TenantAdmin, 'pragmatic-tenant-admin:dev'],
            [ReleaseApp.TenantIdp, 'pragmatic-tenant-idp:dev'],
            [ReleaseApp.UiUnpack, 'pragmatic-ui-unpack:dev'],
            [ReleaseApp.Postgres, 'pragmatic-postgres:local'],
        ])
        assert.deepEqual([...expected.keys()].sort(), [...ReleaseApps.All].sort())
        for (const app of ReleaseApps.All)
        {
            assert.equal(images.ImageOf(app), expected.get(app), app)
            assert.equal(DevPlatformImages.Of(app), expected.get(app), app)
        }
    })

    it('names the env server and the UI unpacker as the tenant plane renders an environment workload, so both agree', () =>
    {
        const record: EnvironmentRecord = { name: 'e1', type: EnvType.Runtime, template: Template.DevBlank, environmentId: 'env-1', hiveId: 'h1', hostPort: 8080, createdAt: 'now', status: EnvStatus.Running, appDeployment: DevImagesFx.AppDeployment }
        const workload = EnvironmentWorkloadFactory.From(record, { id: 'h1' } as unknown as HiveRecord)
        assert.equal(workload.image, DevPlatformImages.Of(ReleaseApp.EnvServer))
        assert.equal(workload.appDeployment?.unpackImage, DevPlatformImages.Of(ReleaseApp.UiUnpack))
        assert.equal(EnvironmentWorkloadFactory.UiUnpackImage, DevPlatformImages.Of(ReleaseApp.UiUnpack))
    })

    it('never names the env server image for an app the env server image does not carry (the agent, the IdP, the tenant console)', () =>
    {
        for (const app of [ReleaseApp.HiveAgent, ReleaseApp.TenantIdp, ReleaseApp.TenantAdmin])
        {
            assert.notEqual(DevPlatformImages.Of(app), DevPlatformImages.Of(ReleaseApp.EnvServer), app)
            assert.notEqual(DevPlatformImages.Of(app), K8sManifestBuilder.AgentImage, app)
        }
    })
})
