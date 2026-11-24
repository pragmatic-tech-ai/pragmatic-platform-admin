import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { HostDto } from '../../../portal-types.js'
import { PageState } from '../../../shell/portal-page-view-model.js'
import { FakeControlPlane, PortalTestHost, Tick } from '../../../shell/tests/portal-test-fixtures.js'
import { HostCodeRevealPageViewModel } from '../host-code-reveal-page-view-model.js'
import { HostsPageViewModel } from '../hosts-page-view-model.js'
import { HostsSectionService } from '../hosts-section-service.js'

// A Hosts section over a fake control plane.
class HostsFixture
{
    public static readonly Host: HostDto = {
        id: 'hsaaaaaaaaaa', machine: 'hive-laptop', clusterKind: 'kind', meshAddress: 'hive-laptop.mesh.pragmatic.test', agentVersion: '0.1.0', keyId: 'k1',
        enrolledAt: '2026-11-24T10:00:00.000Z', enrolledBy: 'operator:ops@pragmatic.test', fresh: true, health: 'healthy', lastReportAt: '2026-11-24T11:59:30.000Z',
        capacity: { CpuMillicores: 8000, MemoryMiB: 32768, StorageGiB: 500 }, allocatable: { CpuMillicores: 6000, MemoryMiB: 24576, StorageGiB: 400 },
        hiveSlots: 4, freeSlots: 3,
        placements: [{ id: 'pl-a', tenantId: 'acme', state: 'placed', label: 'acme-ab2c', hiveHostName: 'acme-ab2c.hives.pragmatic-tech.ai', hiveId: 'hvaaaaaaaaaa', engineVersion: '0.1.0-early.20', placedEngineVersion: '0.1.0-early.20', failure: null, credentialRotation: 1 }],
    }

    public readonly Api = new FakeControlPlane()
    public readonly Host: PortalTestHost
    public readonly Section: HostsSectionService

    public constructor()
    {
        this.Api.Hosts = [HostsFixture.Host, { ...HostsFixture.Host, id: 'hsbbbbbbbbbb', machine: 'spare', fresh: false, lastReportAt: null, capacity: null, hiveSlots: null, freeSlots: 0, placements: [] }]
        this.Host = new PortalTestHost(this.Api.AsClient())
        this.Section = new HostsSectionService(this.Host.Provider)
    }

    public get Content(): unknown
    {
        return this.Host.Host.Content
    }

    public async List(): Promise<HostsPageViewModel>
    {
        this.Section.OnActivated()
        await Tick.Settle()
        assert.ok(this.Content instanceof HostsPageViewModel)
        return this.Content
    }
}

describe('Hosts section', () =>
{
    it('lists each host with its last report, free slots, capacity and placements', async () =>
    {
        const fx = new HostsFixture()
        const list = await fx.List()
        assert.equal(list.State, PageState.Populated)
        assert.deepEqual(list.Rows.ToArray().map(r => [r.Machine, r.MeshAddress, r.LastReportLabel, r.SlotsLabel, r.CapacityLabel, r.PlacementsLabel]), [
            ['hive-laptop', 'hive-laptop.mesh.pragmatic.test', '2026-11-24 11:59', '3 of 4', '8 cores, 32 GiB, 500 GiB disk', 'acme-ab2c placed'],
            ['spare', 'hive-laptop.mesh.pragmatic.test', 'Never', '-', '-', 'None'],
        ])
    })

    it('Issue host code shows the code once; confirming clears it and returns to the list', async () =>
    {
        const fx = new HostsFixture()
        const list = await fx.List()
        assert.equal(list.IssueCodeCommand.CanExecute(), true)
        list.IssueCodeCommand.Execute()
        await Tick.Settle()
        const reveal = fx.Content
        assert.ok(reveal instanceof HostCodeRevealPageViewModel)
        assert.equal(reveal.Value, fx.Api.HostCode)
        assert.match(reveal.Notice, /2026-11-24 12:30/)
        assert.equal(fx.Api.HostCodesIssued, 1)
        reveal.Saved = true
        reveal.ConfirmSavedCommand.Execute()
        await Tick.Settle()
        assert.equal(reveal.Value, '')
        assert.ok(fx.Content instanceof HostsPageViewModel)
    })

    it('an empty host list says how to enrol one', async () =>
    {
        const fx = new HostsFixture()
        fx.Api.Hosts = []
        const list = await fx.List()
        assert.equal(list.State, PageState.Empty)
    })
})
