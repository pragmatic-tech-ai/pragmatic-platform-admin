import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { OperatorContext } from '../../../operator-context.js'
import { PageState } from '../../../shell/portal-page-view-model.js'
import { FakeControlPlane, PortalTestHost, Tick, type FakeDialogService } from '../../../shell/tests/portal-test-fixtures.js'
import { ClientDetailPageViewModel } from '../client-detail-page-view-model.js'
import { ClientsPageViewModel } from '../clients-page-view-model.js'
import { ClientsSectionService } from '../clients-section-service.js'
import type { ClientEntitlementDto } from '../../../portal-types.js'
import { ClientsViewModel } from '../../../clients-view-model.js'

// A Clients section over a fake control plane and fake dialogs.
class ClientsFixture
{
    public readonly Api: FakeControlPlane
    public readonly Host: PortalTestHost
    public readonly Dialogs: FakeDialogService
    public readonly Section: ClientsSectionService

    public constructor(api: FakeControlPlane, wireRole: string = OperatorContext.FullWireRole)
    {
        this.Api = api
        this.Host = new PortalTestHost(api.AsClient(), wireRole)
        this.Dialogs = this.Host.UseDialogs()
        this.Section = new ClientsSectionService(this.Host.Provider)
    }

    public static Seeded(wireRole?: string): ClientsFixture
    {
        const api = new FakeControlPlane()
            .WithClient('acme', 'Acme')
            .WithTenant('acme-prod', 'acme')
            .WithHive('acme-hive', 'acme-prod')
            .WithClient('globex', 'Globex')
        return new ClientsFixture(api, wireRole)
    }

    public async List(): Promise<ClientsPageViewModel>
    {
        this.Section.OnActivated()
        await Tick.Settle()
        assert.ok(this.Host.Host.Content instanceof ClientsPageViewModel)
        return this.Host.Host.Content
    }

    public async Detail(id: string): Promise<ClientDetailPageViewModel>
    {
        const list = await this.List()
        list.OpenCommand.Execute(list.Rows.ToArray().find(r => r.Id === id))
        await Tick.Settle()
        assert.ok(this.Host.Host.Content instanceof ClientDetailPageViewModel)
        return this.Host.Host.Content
    }
}

describe('Clients section', () =>
{
    it('the list loads one row per client with its counts', async () =>
    {
        const fx = ClientsFixture.Seeded()
        const list = await fx.List()
        assert.equal(list.State, PageState.Populated)
        assert.equal(list.Rows.Count, 2)
        const acme = list.Rows.Get(0)
        assert.equal(acme?.DisplayName, 'Acme')
        assert.equal(acme?.TenantCountText, '1')
        assert.equal(acme?.HiveCountText, '1')
        assert.equal(acme?.ConnectionSummary, '1 connected')
        assert.equal(acme?.ClientSinceLabel, '2026-10-01')
    })

    it('no clients -> Empty', async () =>
    {
        const fx = new ClientsFixture(new FakeControlPlane())
        const list = await fx.List()
        assert.equal(list.State, PageState.Empty)
    })

    it('OpenCommand presents the client detail for that row, and Back returns to the list', async () =>
    {
        const fx = ClientsFixture.Seeded()
        const list = await fx.List()
        list.Rows.Get(0)?.OpenCommand.Execute()
        await Tick.Settle()
        const detail = fx.Host.Host.Content
        assert.ok(detail instanceof ClientDetailPageViewModel)
        assert.equal(detail.Id, 'acme')
        assert.equal(detail.State, PageState.Populated)
        assert.equal(detail.DisplayName, 'Acme')
        assert.equal(detail.Tenants.Count, 1)
        assert.equal(detail.Tenants.Get(0)?.HiveName, 'Hive acme-hive')
        assert.equal(detail.Tenants.Get(0)?.ConnectionLabel, 'Connected')
        detail.BackCommand.Execute()
        assert.equal(fx.Host.Host.Content, list)
    })

    it('a missing client shows the Error state', async () =>
    {
        const fx = ClientsFixture.Seeded()
        await fx.List()
        fx.Section.OpenClient('nobody')
        await Tick.Settle()
        const detail = fx.Host.Host.Content as ClientDetailPageViewModel
        assert.equal(detail.State, PageState.Error)
        assert.match(detail.ErrorText, /nobody/)
    })

    it('ClientsViewModel shows Suspended for a suspended statement, its plan, limits and version, and No statement without one', async () =>
    {
        const api = new FakeControlPlane()
            .WithClient('acme', 'Acme', ClientsCases.Statement('suspended'))
            .WithClient('globex', 'Globex', ClientsCases.Statement('active'))
            .WithClient('initech', 'Initech')
        const rows = new ClientsViewModel(await api.ListClients(), [], []).Rows
        assert.deepEqual(rows.map(r => [r.id, r.planLabel, r.stateLabel, r.limitsLabel, r.versionLabel]), [
            ['acme', 'starter', ClientsViewModel.SuspendedLabel, 'tenants 1, hives 2', 'v3'],
            ['globex', 'starter', ClientsViewModel.ActiveLabel, 'tenants 1, hives 2', 'v3'],
            ['initech', ClientsViewModel.NoneLabel, ClientsViewModel.NoStatementLabel, ClientsViewModel.NoneLabel, ClientsViewModel.NoneLabel],
        ])
    })

    it('the list and the detail show the statement and offer no create, edit or delete', async () =>
    {
        const fx = new ClientsFixture(new FakeControlPlane().WithClient('acme', 'Acme', ClientsCases.Statement('suspended')))
        const list = await fx.List()
        const row = list.Rows.Get(0)
        assert.deepEqual([row?.PlanLabel, row?.StateLabel, row?.LimitsLabel, row?.VersionLabel], ['starter', ClientsViewModel.SuspendedLabel, 'tenants 1, hives 2', 'v3'])
        assert.equal('NewCommand' in list, false)
        const detail = await fx.Detail('acme')
        assert.deepEqual([detail.PlanLabel, detail.StateLabel, detail.LimitsLabel, detail.VersionLabel, detail.AdminsLabel],
            ['starter', ClientsViewModel.SuspendedLabel, 'tenants 1, hives 2', 'v3', 'admin@acme.test'])
        assert.equal('DeleteCommand' in detail, false)
    })
})

// Statements for the clients views.
class ClientsCases
{
    public static Statement(state: string): ClientEntitlementDto
    {
        return {
            planId: 'starter', state, limits: { 'tenants': 1, 'hives': 2 }, version: 3, issuedAt: '2026-11-20T10:00:00.000Z',
            admins: [{ issuer: 'https://login.example.test/realms/central', subject: 'sub-1', email: 'admin@acme.test' }],
        }
    }
}
