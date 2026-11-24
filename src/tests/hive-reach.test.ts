import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { ServerResponse } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HiveLevel as CustomerHiveLevel } from '@pragmatic-tech-ai/pragmatic-customer-api-contract'
import { HiveLevel } from '@pragmatic-tech-ai/pragmatic-hive-protocol'
import { FakeHiveAgent } from '@pragmatic-tech-ai/pragmatic-hive-protocol/testing'
import { SystemInstallClock } from '@pragmatic-tech-ai/pragmatic-kube'
import { HiveBackend, InfraMode, UnsupportedBackendError, type HiveRecord } from '@pragmatic-tech-ai/pragmatic-tenant-plane'
import { ControlPlaneProblems } from '../control-plane-problems.js'
import { HiveAgentInstaller } from '../hive-agent-installer.js'
import { HiveChannelWorld } from '../hive-channel/tests/hive-channel-world.js'
import { HiveNotPushableError, HiveReach } from '../hive-reach.js'
import { HostedHiveOrchestratorFactory } from '../hosted-hive-orchestrator-factory.js'
import { PlatformHiveOrchestratorFactory } from '../platform-hive-orchestrator-factory.js'
import type { PlatformHiveRecord } from '../platform-records.js'
import { ConsoleInstallFixture } from './console-install-fakes.js'
import { ResRecorder } from './res-recorder.js'
import { IntentRefusal, IntentRefusedError } from '../intents/intent-publisher.js'
import { IntentSequenceContendedError } from '../intents/sql-intent-sequences.js'
import { RolloutFixture } from './rollout-fixture.js'

class ReachCases
{
    public static Record(level: CustomerHiveLevel | undefined): PlatformHiveRecord
    {
        const hive: PlatformHiveRecord = { ...ConsoleInstallFixture.Hive('h1'), publicKey: 'key', keyId: 'k1' }
        return level === undefined ? hive : { ...hive, level }
    }

    public static NotPushable(error: unknown): boolean
    {
        return error instanceof HiveNotPushableError
    }

    public static async EnrolledWorld(level: HiveLevel): Promise<{ world: HiveChannelWorld, hiveId: string }>
    {
        const world = await HiveChannelWorld.Create()
        const agent = new FakeHiveAgent(world.Channel, world.Clock, world.TrustRoot.PublicKey)
        await agent.Enrol(await world.IssueCode(HiveChannelWorld.TenantA, level as string as CustomerHiveLevel), HiveChannelWorld.TenantA, level)
        return { world, hiveId: agent.Self.Id }
    }
}

describe('HiveReach', () =>
{
    it('hosted and legacy hives still push; enrolled and delegated ones never do', () =>
    {
        assert.equal(HiveReach.Pushable(ReachCases.Record(CustomerHiveLevel.Hosted)), true)
        assert.equal(HiveReach.Pushable(ReachCases.Record(undefined)), true)
        assert.equal(HiveReach.Pushable(ReachCases.Record(CustomerHiveLevel.Enrolled)), false)
        assert.equal(HiveReach.Pushable(ReachCases.Record(CustomerHiveLevel.Delegated)), false)
        assert.throws(() => HiveReach.Require(ReachCases.Record(CustomerHiveLevel.Delegated)), ReachCases.NotPushable)
    })

    it('every orchestrator factory refuses an enrolled or delegated hive with hive-not-pushable, never a hosted or legacy one', () =>
    {
        const dir = mkdtempSync(join(tmpdir(), 'hive-reach-'))
        const factories = [new PlatformHiveOrchestratorFactory(undefined, dir), new HostedHiveOrchestratorFactory(undefined, dir)]
        for (const factory of factories)
        {
            for (const level of [CustomerHiveLevel.Enrolled, CustomerHiveLevel.Delegated])
            {
                assert.throws(() => factory.For(ReachCases.Record(level)), ReachCases.NotPushable)
            }
            const hosted: HiveRecord = { ...ReachCases.Record(CustomerHiveLevel.Hosted), cluster: { backend: HiveBackend.Local, mode: InfraMode.Attach, configRef: 'kind-pragmatic-hive' } }
            assert.doesNotThrow(() => factory.For(hosted))
            const legacy: HiveRecord = { ...ReachCases.Record(undefined), cluster: { backend: HiveBackend.Aks, mode: InfraMode.Attach } }
            assert.throws(() => factory.For(legacy), (error: unknown) => error instanceof UnsupportedBackendError)
        }
    })

    it('the console installer refuses an install and an Owner reset on a hive managed by pulls', async () =>
    {
        const fixture = await ConsoleInstallFixture.Create()
        fixture.Hives.set('h1', ReachCases.Record(CustomerHiveLevel.Enrolled))
        assert.throws(() => fixture.Installer.Start('h1'), ReachCases.NotPushable)
        await assert.rejects(fixture.Installer.ResetOwnerPassword('h1'), ReachCases.NotPushable)
        assert.deepEqual(fixture.Kubectl.Calls, [])
    })

    it('the agent installer, the agent token and a pushed release selection refuse a hive managed by pulls', async () =>
    {
        const { world, hiveId } = await ReachCases.EnrolledWorld(HiveLevel.Delegated)
        const dir = mkdtempSync(join(tmpdir(), 'hive-reach-'))
        const deployments = await RolloutFixture.Create(dir, world.Directory, new PlatformHiveOrchestratorFactory(undefined, dir))
        const installer = new HiveAgentInstaller(world.Directory, new PlatformHiveOrchestratorFactory(undefined, dir), deployments, RolloutFixture.Observations(dir), 'http://agent.test', new SystemInstallClock(), { pollIntervalMs: 5, timeoutMs: 50 })
        assert.throws(() => installer.Start(hiveId), ReachCases.NotPushable)
        await assert.rejects(deployments.RegisterHive(hiveId), ReachCases.NotPushable)
        await assert.rejects(deployments.SelectTarget(hiveId, '0.1.0-early.20'), ReachCases.NotPushable)
    })

    it('the operator API answers a refused push 409 with the code hive-not-pushable', () =>
    {
        const res = new ResRecorder()
        new ControlPlaneProblems(() => undefined).Write(res as unknown as ServerResponse, new HiveNotPushableError())
        assert.equal(res.status, 409)
        assert.equal(res.Json<{ code: string }>().code, HiveNotPushableError.Code)
    })

    it('an intent refusal answers its own status and code; a contended sequence 503 with its code', () =>
    {
        const problems = new ControlPlaneProblems(() => undefined)
        for (const [code, status] of [[IntentRefusal.UnknownHive, 404], [IntentRefusal.Malformed, 400], [IntentRefusal.HiveTakesNoIntents, 409]] as const)
        {
            const res = new ResRecorder()
            problems.Write(res as unknown as ServerResponse, new IntentRefusedError(code))
            assert.deepEqual([res.status, res.Json<{ code: string }>().code], [status, code])
        }
        const res = new ResRecorder()
        problems.Write(res as unknown as ServerResponse, new IntentSequenceContendedError())
        assert.deepEqual([res.status, res.Json<{ code: string }>().code], [503, IntentSequenceContendedError.Code])
    })
})

