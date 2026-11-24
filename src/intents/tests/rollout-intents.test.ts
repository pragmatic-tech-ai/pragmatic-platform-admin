import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HiveLevel as CustomerHiveLevel } from '@pragmatic-tech-ai/pragmatic-customer-api-contract'
import { ComponentAtVersion, HiveLevel, IntentActionKind, IntentProgress, IntentStatus, SignedEnvelope, Intent } from '@pragmatic-tech-ai/pragmatic-hive-protocol'
import { FakeHiveAgent } from '@pragmatic-tech-ai/pragmatic-hive-protocol/testing'
import { ReleaseApp } from '@pragmatic-tech-ai/pragmatic-release-toolkit'
import { ReleaseState, type ManifestRecord } from '@pragmatic-tech-ai/pragmatic-tenant-plane'
import { ReleaseNotRunnableYetError } from '@pragmatic-tech-ai/pragmatic-platform-link'
import { HiveChannelWorld } from '../../hive-channel/tests/hive-channel-world.js'
import { PlatformHiveOrchestratorFactory } from '../../platform-hive-orchestrator-factory.js'
import type { PlatformDeploymentRegistry } from '../../platform-deployment-registry.js'
import { RolloutFixture } from '../../tests/rollout-fixture.js'
import { RolloutIntents } from '../rollout-intents.js'
import type { PlatformHiveRecord } from '../../platform-records.js'
import { IntentRefusal, IntentRefusedError } from '../intent-publisher.js'

class ReleaseCases
{
    public static readonly First = '0.1.0-early.20'
    public static readonly Second = '0.1.0-early.21'

    public static Digest(seed: string): string
    {
        return 'sha256:' + seed.repeat(64).slice(0, 64)
    }

    /** A verified registry release: each engine image digest named by `seeds` (app -> one hex letter). */
    public static Release(version: string, seeds: Partial<Record<ReleaseApp, string>>): ManifestRecord
    {
        const images: Partial<Record<ReleaseApp, { repository: string; digest: string; componentDigest?: string }>> = {}
        for (const [app, seed] of Object.entries(seeds) as [ReleaseApp, string][])
        {
            images[app] = { repository: 'ghcr.io/pragmatic-tech-ai/' + app, digest: ReleaseCases.Digest(seed), componentDigest: ReleaseCases.Digest('f') }
        }
        return { id: version, image: 'ghcr.io/pragmatic-tech-ai/pragmatic-env-server@' + ReleaseCases.Digest('e'), publishedAt: '2026-11-24T00:00:00.000Z', release: { state: ReleaseState.Verified, images } }
    }

    public static async World(): Promise<{ world: HiveChannelWorld, hive: FakeHiveAgent, deployments: PlatformDeploymentRegistry }>
    {
        const world = await HiveChannelWorld.Create()
        const hive = new FakeHiveAgent(world.Channel, world.Clock, world.TrustRoot.PublicKey)
        await hive.Enrol(await world.IssueCode(HiveChannelWorld.TenantA, CustomerHiveLevel.Delegated), HiveChannelWorld.TenantA, HiveLevel.Delegated)
        const dir = mkdtempSync(join(tmpdir(), 'rollout-intents-'))
        const deployments = await RolloutFixture.Create(dir, world.Directory, new PlatformHiveOrchestratorFactory(undefined, dir), new RolloutIntents(world.Publisher, world.Intents))
        return { world, hive, deployments }
    }

    public static Components(world: HiveChannelWorld, hiveId: string): ComponentAtVersion[]
    {
        return world.Intents.ForHive(hiveId).map(record => Intent.Parse(SignedEnvelope.Decode(record.envelope).Body).Action as ComponentAtVersion)
    }
}

describe('RolloutIntents', () =>
{
    it('a release change publishes one intent per changed component with the agent last', async () =>
    {
        const { world, hive, deployments } = await ReleaseCases.World()
        await deployments.ImportRelease(ReleaseCases.Release(ReleaseCases.First, { [ReleaseApp.HiveAgent]: 'a', [ReleaseApp.TenantAdmin]: 'b', [ReleaseApp.TenantIdp]: 'c', [ReleaseApp.Postgres]: 'd', [ReleaseApp.EnvServer]: '1' }))
        await deployments.Gate(HiveChannelWorld.TenantA, ReleaseCases.First)
        await deployments.SelectTarget(hive.Self.Id, ReleaseCases.First)
        const first = ReleaseCases.Components(world, hive.Self.Id)
        assert.deepEqual(first.map(action => action.Component), [ReleaseApp.TenantAdmin, ReleaseApp.TenantIdp, ReleaseApp.Postgres, ReleaseApp.HiveAgent])
        assert.ok(first.every(action => action.Kind === IntentActionKind.ComponentAtVersion && action.Version === ReleaseCases.First))
        assert.equal(first[0]?.ImageDigest, ReleaseCases.Digest('b'))
        assert.equal(deployments.TargetFor(hive.Self.Id)?.version, ReleaseCases.First)
        const pulled = await hive.PullIntents()
        assert.equal(pulled.length, 4)
    })

    it('an unchanged component gets no intent', async () =>
    {
        const { world, hive, deployments } = await ReleaseCases.World()
        const same = { [ReleaseApp.TenantIdp]: 'c', [ReleaseApp.Postgres]: 'd' }
        await deployments.ImportRelease(ReleaseCases.Release(ReleaseCases.First, { [ReleaseApp.HiveAgent]: 'a', [ReleaseApp.TenantAdmin]: 'b', ...same }))
        await deployments.ImportRelease(ReleaseCases.Release(ReleaseCases.Second, { [ReleaseApp.HiveAgent]: '2', [ReleaseApp.TenantAdmin]: '3', ...same }))
        await deployments.Gate(HiveChannelWorld.TenantA, ReleaseCases.First)
        await deployments.Gate(HiveChannelWorld.TenantA, ReleaseCases.Second)
        await deployments.SelectTarget(hive.Self.Id, ReleaseCases.First)
        const before = world.Intents.ForHive(hive.Self.Id).length
        await deployments.SelectTarget(hive.Self.Id, ReleaseCases.Second)
        const added = ReleaseCases.Components(world, hive.Self.Id).slice(before)
        assert.deepEqual(added.map(action => action.Component), [ReleaseApp.TenantAdmin, ReleaseApp.HiveAgent])
        await deployments.SelectTarget(hive.Self.Id, ReleaseCases.Second)
        assert.equal(world.Intents.ForHive(hive.Self.Id).length, before + 2)
    })

    it('a pulling hive is moved only to a verified registry release, and only through its gating', async () =>
    {
        const { hive, deployments } = await ReleaseCases.World()
        await deployments.Publish('0.9.0', 'pragmatic/env:0.9.0')
        await deployments.Gate(HiveChannelWorld.TenantA, '0.9.0')
        await assert.rejects(deployments.SelectTarget(hive.Self.Id, '0.9.0'), ReleaseNotRunnableYetError)
        await deployments.ImportRelease(ReleaseCases.Release(ReleaseCases.First, { [ReleaseApp.HiveAgent]: 'a' }))
        await assert.rejects(deployments.SelectTarget(hive.Self.Id, ReleaseCases.First))
    })

    it('diffs against what the hive runs: the release it enrolled at, then what it applied; superseding an older open one', async () =>
    {
        const { world, hive, deployments } = await ReleaseCases.World()
        const runs = (world.Directory.GetHive(hive.Self.Id) as PlatformHiveRecord).engineVersion as string
        const base = { [ReleaseApp.TenantIdp]: 'c', [ReleaseApp.Postgres]: 'd' }
        await deployments.ImportRelease(ReleaseCases.Release(runs, { [ReleaseApp.HiveAgent]: 'a', [ReleaseApp.TenantAdmin]: 'b', ...base }))
        await deployments.ImportRelease(ReleaseCases.Release(ReleaseCases.First, { [ReleaseApp.HiveAgent]: 'a', [ReleaseApp.TenantAdmin]: '3', ...base }))
        await deployments.ImportRelease(ReleaseCases.Release(ReleaseCases.Second, { [ReleaseApp.HiveAgent]: 'a', [ReleaseApp.TenantAdmin]: '4', ...base }))
        await deployments.Gate(HiveChannelWorld.TenantA, ReleaseCases.First)
        await deployments.Gate(HiveChannelWorld.TenantA, ReleaseCases.Second)
        await deployments.SelectTarget(hive.Self.Id, ReleaseCases.First)
        const [first] = world.Intents.ForHive(hive.Self.Id)
        assert.deepEqual(ReleaseCases.Components(world, hive.Self.Id).map(action => action.Component), [ReleaseApp.TenantAdmin])
        await deployments.SelectTarget(hive.Self.Id, ReleaseCases.Second)
        const [, second] = world.Intents.ForHive(hive.Self.Id)
        assert.equal(world.Intents.Get(first!.id)?.supersededBy, second?.id, 'the older open intent is superseded, never served beside the new one')
        assert.deepEqual((await hive.PullIntents()).map(item => item.Body.IntentId), [second?.id])
        await world.Intents.RecordProgress(hive.Self.Id, [IntentStatus.Of(second!.id, IntentProgress.Applied)])
        await deployments.SelectTarget(hive.Self.Id, ReleaseCases.Second)
        assert.equal(world.Intents.ForHive(hive.Self.Id).length, 2, 'what the hive applied is not asked again')
    })

    it('a selection whose intents cannot be published records nothing; a hive that takes no intents is refused with its code', async () =>
    {
        const { world, hive, deployments } = await ReleaseCases.World()
        await deployments.ImportRelease(ReleaseCases.Release(ReleaseCases.First, { [ReleaseApp.HiveAgent]: 'a' }))
        await deployments.Gate(HiveChannelWorld.TenantA, ReleaseCases.First)
        await world.Directory.MarkHiveLeft(hive.Self.Id)
        await assert.rejects(deployments.SelectTarget(hive.Self.Id, ReleaseCases.First), (error: unknown) => error instanceof IntentRefusedError && error.Code === IntentRefusal.HiveTakesNoIntents)
        assert.equal(deployments.TargetFor(hive.Self.Id), undefined)
        assert.deepEqual(world.Intents.ForHive(hive.Self.Id), [])
    })
})
