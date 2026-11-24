import { ObservableCollection, type RelayCommand } from '@pragmatic-tech-ai/mural/runtime'
import { Observable } from '@pragmatic-tech-ai/todl-runtime'
import { PortalDates } from '../../portal-dates.js'
import type { HostDto, HostPlacementDto } from '../../portal-types.js'
import { PortalPageViewModel } from '../../shell/portal-page-view-model.js'
import type { PortalSessionService } from '../../shell/portal-session-service.js'
import type { HostsSectionService } from './hosts-section-service.js'

// One host as the list shows it: machine, mesh address, report freshness,
// free slots of its hive slots, capacity, and the placements on it.
export class HostRowViewModel extends Observable
{
    private static readonly NeverLabel = 'Never'
    private static readonly StaleSuffix = ' (stale)'
    private static readonly SlotsSeparator = ' of '
    private static readonly NoValue = '-'
    private static readonly CapacityTemplate = '{cpu} cores, {memory} GiB, {storage} GiB disk'
    private static readonly CpuToken = '{cpu}'
    private static readonly MemoryToken = '{memory}'
    private static readonly StorageToken = '{storage}'
    private static readonly NoPlacements = 'None'
    private static readonly PlacementSeparator = ', '
    private static readonly PlacementStateSeparator = ' '
    private static readonly MillicoresPerCore = 1000
    private static readonly MiBPerGiB = 1024

    public constructor(public readonly Host: HostDto)
    {
        super()
    }

    public get Machine(): string
    {
        return this.Host.machine
    }

    public get MeshAddress(): string
    {
        return this.Host.meshAddress
    }

    // When it last reported (UTC), marked stale when the scheduler skips it.
    public get LastReportLabel(): string
    {
        const H = HostRowViewModel
        if (this.Host.lastReportAt === null)
        {
            return H.NeverLabel
        }
        const when = PortalDates.DateTimeLabel(this.Host.lastReportAt)
        return this.Host.fresh ? when : when + H.StaleSuffix
    }

    public get SlotsLabel(): string
    {
        const H = HostRowViewModel
        return this.Host.hiveSlots === null ? H.NoValue : String(this.Host.freeSlots) + H.SlotsSeparator + String(this.Host.hiveSlots)
    }

    public get CapacityLabel(): string
    {
        const H = HostRowViewModel
        const capacity = this.Host.capacity
        if (capacity === null)
        {
            return H.NoValue
        }
        return H.CapacityTemplate
            .replace(H.CpuToken, String(Math.round(capacity.CpuMillicores / H.MillicoresPerCore)))
            .replace(H.MemoryToken, String(Math.round(capacity.MemoryMiB / H.MiBPerGiB)))
            .replace(H.StorageToken, String(capacity.StorageGiB))
    }

    // The placements on the host: label (or id) and state.
    public get PlacementsLabel(): string
    {
        const H = HostRowViewModel
        const shown = this.Host.placements.map(placement => HostRowViewModel.PlacementLabel(placement))
        return shown.length === 0 ? H.NoPlacements : shown.join(H.PlacementSeparator)
    }

    private static PlacementLabel(placement: HostPlacementDto): string
    {
        return (placement.label ?? placement.id) + HostRowViewModel.PlacementStateSeparator + placement.state
    }
}

// Hosts: the machines that host Hosted hives, each with its capacity, free
// slots, last report and placements. Issue host code (operator.full) issues a
// one-time code that enrols a new host agent, shown once.
export class HostsPageViewModel extends PortalPageViewModel
{
    private readonly rows = new ObservableCollection<HostRowViewModel>()
    private readonly issueCodeCommand: RelayCommand

    public constructor(session: PortalSessionService, private readonly section: HostsSectionService)
    {
        super(session)
        this.issueCodeCommand = this.MutatingCommand(() => this.IssueCode())
    }

    public get Rows(): ObservableCollection<HostRowViewModel>
    {
        return this.rows
    }

    public get IssueCodeCommand(): RelayCommand
    {
        return this.issueCodeCommand
    }

    protected override async LoadCore(): Promise<boolean>
    {
        const generation = this.LoadGeneration
        const hosts = await this.Session.Client.ListHosts()
        if (generation !== this.LoadGeneration)
        {
            return false
        }
        this.rows.Clear()
        for (const host of hosts)
        {
            this.rows.Add(new HostRowViewModel(host))
        }
        return this.rows.Count > 0
    }

    private async IssueCode(): Promise<void>
    {
        const issued = await this.Session.Client.IssueHostCode()
        this.section.RevealCode(issued.code, issued.expiresAt)
    }
}
