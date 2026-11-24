import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { HiveHealth } from '@pragmatic-tech-ai/pragmatic-customer-api-contract'
import {
    AgentExchangeRefusal, ComponentReport, ComponentState, EnvironmentReadiness, EnvironmentStatus, HiveLevel, HiveReport, IntentProgress, IntentStatus,
} from '@pragmatic-tech-ai/pragmatic-hive-protocol'
import { FakeHiveAgent } from '@pragmatic-tech-ai/pragmatic-hive-protocol/testing'
import { HiveViews } from '../../customer/hive-views.js'
import type { PlatformHiveRecord } from '../../platform-records.js'
import { HiveChannelWorld, WorldRefusalError } from './hive-channel-world.js'

class ReportCases
{
    public static readonly Version = '0.1.7'
    public static readonly Agent = 'pragmatic-hive-agent'
    public static readonly Environment = 'dev-one'

    public static Report(state: ComponentState = ComponentState.Ready, readiness: EnvironmentReadiness = EnvironmentReadiness.Ready): HiveReport
    {
        return HiveReport.Create({
            EngineVersion: ReportCases.Version,
            Components: [new ComponentReport(ReportCases.Agent, state, ReportCases.Version)],
            Environments: [new EnvironmentStatus(ReportCases.Environment, readiness, ReportCases.Version)],
            Intents: [new IntentStatus('intent-1', IntentProgress.Applied)],
        })
    }

    public static async Enrolled(world: HiveChannelWorld): Promise<FakeHiveAgent>
    {
        const agent = new FakeHiveAgent(world.Channel, world.Clock)
        await agent.Enrol(await world.IssueCode(), HiveChannelWorld.TenantA, HiveLevel.Enrolled)
        return agent
    }
}

describe('HiveReportHandler', () =>
{
    it('a report updates last-seen, components and environments; free text is impossible by type', async () =>
    {
        const world = await HiveChannelWorld.Create()
        const agent = await ReportCases.Enrolled(world)
        const hive = world.Directory.GetHive(agent.Self.Id) as PlatformHiveRecord
        assert.equal(HiveViews.Of(hive, world.LatestObservation(hive.id), new Date()).Health, HiveHealth.Pending)
        await agent.Report(ReportCases.Report())
        const observation = world.LatestObservation(hive.id)
        assert.ok(observation !== undefined)
        assert.equal(observation.engineVersion, ReportCases.Version)
        assert.deepEqual(observation.components, [{ component: ReportCases.Agent, state: ComponentState.Ready, version: ReportCases.Version }])
        assert.deepEqual(observation.environments.map(environment => [environment.environmentName, environment.ready]), [[ReportCases.Environment, true]])
        assert.deepEqual(observation.intents, [{ intentId: 'intent-1', progress: IntentProgress.Applied }])
        assert.equal(HiveViews.Of(hive, observation, new Date()).Health, HiveHealth.Healthy)
        assert.equal(HiveViews.Of(hive, observation, new Date()).Home, true)
        // Free text has no member to travel in: the strict codec refuses any extra member.
        assert.throws(() => HiveReport.Parse({ ...ReportCases.Report().ToJson(), Note: 'free text' }))
    })

    it('a component that is not ready degrades the hive', async () =>
    {
        const world = await HiveChannelWorld.Create()
        const agent = await ReportCases.Enrolled(world)
        await agent.Report(ReportCases.Report(ComponentState.Degraded))
        const hive = world.Directory.GetHive(agent.Self.Id) as PlatformHiveRecord
        assert.equal(HiveViews.Of(hive, world.LatestObservation(hive.id), new Date()).Health, HiveHealth.Degraded)
    })

    it('a report from a gone hive is refused', async () =>
    {
        const world = await HiveChannelWorld.Create()
        const agent = await ReportCases.Enrolled(world)
        await world.Directory.MarkHiveLeft(agent.Self.Id)
        await assert.rejects(agent.Report(ReportCases.Report()), (error: unknown) => error instanceof WorldRefusalError && error.Code === AgentExchangeRefusal.HiveGone)
        assert.equal(world.LatestObservation(agent.Self.Id), undefined)
    })

    it('a captured report replayed is refused', async () =>
    {
        const world = await HiveChannelWorld.Create()
        const agent = await ReportCases.Enrolled(world)
        await agent.Report(ReportCases.Report())
        const captured = world.Channel.Sent.at(-1) as string
        await assert.rejects(world.Channel.SendText(captured), (error: unknown) => error instanceof WorldRefusalError && error.Code === AgentExchangeRefusal.Replayed)
    })
})
