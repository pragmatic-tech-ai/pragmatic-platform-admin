import { ObservableCollection, RelayCommand } from '@pragmatic-tech-ai/mural/runtime'
import { Observable } from '@pragmatic-tech-ai/todl-runtime'
import { FleetViewModel, type FleetRow } from '../../fleet-view-model.js'
import { ClientsViewModel } from '../../clients-view-model.js'
import { PortalDates } from '../../portal-dates.js'
import type { ClientDto, FleetHiveDto, TenantDto } from '../../portal-types.js'
import { PortalPageViewModel } from '../../shell/portal-page-view-model.js'
import type { PortalSessionService } from '../../shell/portal-session-service.js'
import { FleetHiveRowViewModel } from '../fleet/fleet-page-view-model.js'
import type { ClientsSectionService } from './clients-section-service.js'

// One of the client's tenants, with the hive that serves it.
export class ClientTenantRowViewModel extends Observable
{
    private static readonly NoHiveLabel = 'No hive yet'
    private static readonly NoneLabel = '-'

    public constructor(private readonly tenant: TenantDto, private readonly hive: FleetHiveDto | undefined, private readonly row: FleetRow | undefined)
    {
        super()
    }

    public get TenantId(): string
    {
        return this.tenant.id
    }

    public get TenantName(): string
    {
        return this.tenant.displayName
    }

    public get HiveName(): string
    {
        return this.hive?.displayName ?? ClientTenantRowViewModel.NoHiveLabel
    }

    public get ConnectionLabel(): string
    {
        return this.row === undefined ? ClientTenantRowViewModel.NoneLabel : FleetHiveRowViewModel.ConnectionText(this.row.connection)
    }

    public get LastSeenLabel(): string
    {
        return this.row?.lastSeenLabel ?? ClientTenantRowViewModel.NoneLabel
    }

    public get EnvCountText(): string
    {
        return String(this.hive?.environments.length ?? 0)
    }
}

// A client's detail: what the clients ledger states of it (plan, state, limits, statement version, customer admins;
// never a price) and its tenants with their hives. Read-only: the ledger owns the client.
export class ClientDetailPageViewModel extends PortalPageViewModel
{
    private static readonly NotFoundTemplate = 'Client {id} was not found.'
    private static readonly IdToken = '{id}'
    private static readonly AdminSeparator = ', '
    private static readonly VersionPrefix = 'v'
    private static readonly ClientProperty = 'Client'
    private static readonly DisplayNameProperty = 'DisplayName'
    private static readonly PlanLabelProperty = 'PlanLabel'
    private static readonly StateLabelProperty = 'StateLabel'
    private static readonly LimitsLabelProperty = 'LimitsLabel'
    private static readonly VersionLabelProperty = 'VersionLabel'
    private static readonly AdminsLabelProperty = 'AdminsLabel'
    private static readonly ClientSinceLabelProperty = 'ClientSinceLabel'
    private static readonly HasTenantsProperty = 'HasTenants'
    private static readonly HasNoTenantsProperty = 'HasNoTenants'

    private client: ClientDto | undefined
    private readonly tenants = new ObservableCollection<ClientTenantRowViewModel>()

    public constructor(session: PortalSessionService, private readonly section: ClientsSectionService, public readonly Id: string)
    {
        super(session)
    }

    public get DisplayName(): string
    {
        return this.client?.displayName ?? this.Id
    }

    public get PlanLabel(): string
    {
        return this.client?.entitlement?.planId ?? ClientsViewModel.NoneLabel
    }

    public get StateLabel(): string
    {
        return ClientsViewModel.StateLabel(this.client?.entitlement)
    }

    public get LimitsLabel(): string
    {
        return ClientsViewModel.LimitsLabel(this.client?.entitlement)
    }

    public get VersionLabel(): string
    {
        const entitlement = this.client?.entitlement
        return entitlement === undefined ? ClientsViewModel.NoneLabel : ClientDetailPageViewModel.VersionPrefix + String(entitlement.version)
    }

    /** The customer admins' emails (informational; the central-login subject identifies each). */
    public get AdminsLabel(): string
    {
        const admins = this.client?.entitlement?.admins ?? []
        return admins.length === 0 ? ClientsViewModel.NoneLabel : admins.map(admin => admin.email).join(ClientDetailPageViewModel.AdminSeparator)
    }

    public get ClientSinceLabel(): string
    {
        return PortalDates.Label(this.client?.createdAt)
    }

    public get Tenants(): ObservableCollection<ClientTenantRowViewModel>
    {
        return this.tenants
    }

    public get HasTenants(): boolean
    {
        return this.tenants.Count > 0
    }

    public get HasNoTenants(): boolean
    {
        return this.tenants.Count === 0
    }

    public get BackCommand(): RelayCommand
    {
        return this.section.BackCommand
    }

    protected override async LoadCore(): Promise<boolean>
    {
        const generation = this.LoadGeneration
        const api = this.Session.Client
        const [clients, tenants, fleet] = await Promise.all([api.ListClients(), api.ListTenants(this.Id), api.ListFleet()])
        if (generation !== this.LoadGeneration)
        {
            return false
        }
        const client = clients.find(c => c.id === this.Id)
        if (client === undefined)
        {
            throw new Error(ClientDetailPageViewModel.NotFoundTemplate.replace(ClientDetailPageViewModel.IdToken, this.Id))
        }
        this.Apply(client, tenants, fleet)
        return true
    }

    private Apply(client: ClientDto, tenants: TenantDto[], fleet: FleetHiveDto[]): void
    {
        const D = ClientDetailPageViewModel
        const oldName = this.DisplayName
        const oldPlan = this.PlanLabel
        const oldState = this.StateLabel
        const oldLimits = this.LimitsLabel
        const oldVersion = this.VersionLabel
        const oldAdmins = this.AdminsLabel
        const oldSince = this.ClientSinceLabel
        const hadTenants = this.HasTenants
        const old = this.client
        this.client = client
        const rows = new Map<string, FleetRow>()
        for (const row of new FleetViewModel(fleet).Rows)
        {
            rows.set(row.id, row)
        }
        this.tenants.Clear()
        for (const tenant of tenants)
        {
            const hive = fleet.find(h => h.tenant?.id === tenant.id)
            this.tenants.Add(new ClientTenantRowViewModel(tenant, hive, hive === undefined ? undefined : rows.get(hive.id)))
        }
        this.RaisePropertyChanged(ClientDetailPageViewModel.ClientProperty, old, client)
        this.RaisePropertyChanged(ClientDetailPageViewModel.DisplayNameProperty, oldName, this.DisplayName)
        this.RaisePropertyChanged(D.PlanLabelProperty, oldPlan, this.PlanLabel)
        this.RaisePropertyChanged(D.StateLabelProperty, oldState, this.StateLabel)
        this.RaisePropertyChanged(D.LimitsLabelProperty, oldLimits, this.LimitsLabel)
        this.RaisePropertyChanged(D.VersionLabelProperty, oldVersion, this.VersionLabel)
        this.RaisePropertyChanged(D.AdminsLabelProperty, oldAdmins, this.AdminsLabel)
        this.RaisePropertyChanged(ClientDetailPageViewModel.ClientSinceLabelProperty, oldSince, this.ClientSinceLabel)
        this.RaisePropertyChanged(ClientDetailPageViewModel.HasTenantsProperty, hadTenants, this.HasTenants)
        this.RaisePropertyChanged(ClientDetailPageViewModel.HasNoTenantsProperty, !hadTenants, this.HasNoTenants)
    }
}
