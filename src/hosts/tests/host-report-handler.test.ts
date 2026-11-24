import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { HostHealth, PlacementState as HostPlacementState } from '@pragmatic-tech-ai/pragmatic-hive-protocol'
import { HostRegistry } from '../host-registry.js'
import { HostWorld } from './host-world.js'

describe('HostReportHandler', () =>
{
    it('capacity reports update the host\'s free slots and freshness', async () =>
    {
        const world = await HostWorld.Create()
        const agent = await world.EnrolledHost()
        assert.equal(HostRegistry.FreeSlots(world.Host(agent), 0), 0, 'no report yet: no slots')
        assert.equal(HostRegistry.IsFresh(world.Host(agent), world.Clock.Now()), false)
        await agent.Report(HostWorld.Report(4))
        const host = world.Host(agent)
        assert.equal(HostRegistry.FreeSlots(host, 0), 4)
        assert.equal(HostRegistry.FreeSlots(host, 3), 1)
        assert.equal(host.lastReport?.Capacity.CpuMillicores, 8000)
        assert.equal(HostRegistry.IsFresh(host, world.Clock.Now()), true)
        await agent.Report(HostWorld.Report(4, HostHealth.Healthy, [['pl-a', HostPlacementState.Running], ['pl-b', HostPlacementState.Removing]]))
        assert.equal(HostRegistry.FreeSlots(world.Host(agent), 1), 2, 'the host\'s own count wins when it is higher')
        world.Clock.Advance(HostRegistry.FreshMs + 1)
        assert.equal(HostRegistry.IsFresh(world.Host(agent), world.Clock.Now()), false, 'older than two minutes: stale')
        await agent.Report(HostWorld.Report(4, HostHealth.Degraded))
        assert.equal(HostRegistry.IsFresh(world.Host(agent), world.Clock.Now()), false, 'not healthy: not fresh')
    })

    it('FreeSlots ignores failed placements in the report', async () =>
    {
        const world = await HostWorld.Create()
        const agent = await world.EnrolledHost()
        await agent.Report(HostWorld.Report(4, HostHealth.Healthy, [['pl-a', HostPlacementState.Failed], ['pl-b', HostPlacementState.Failed], ['pl-c', HostPlacementState.Running]]))
        assert.equal(HostRegistry.FreeSlots(world.Host(agent), 0), 3)
    })
})
