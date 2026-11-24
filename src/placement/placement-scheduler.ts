import { randomBytes } from 'node:crypto'
import { HiveLevel } from '@pragmatic-tech-ai/pragmatic-customer-api-contract'
import { ConsoleAddress, PlacementRequest } from '@pragmatic-tech-ai/pragmatic-hive-protocol'
import type { EnrolmentCodeRequest } from '../enrolment/enrolment-code-issuer.js'
import { EnrolmentAgentKind } from '../enrolment/enrolment-code-record.js'
import type { HostRecord } from '../hosts/host-record.js'
import { HostRegistry } from '../hosts/host-registry.js'
import { VersionOrder } from '../version-order.js'
import type { IOfferedReleases } from './offered-releases.js'
import type { PlacementHiveLink } from './placement-hive-link.js'
import type { PlacementQueue } from './placement-queue.js'
import { PlacementState, type PlacementRecord } from './placement-record.js'
import { PlacementRegistry } from './placement-registry.js'

/** The hive codes a placement request carries (EnrolmentCodeIssuer). */
export interface IPlacementCodes
{
    Issue(request: EnrolmentCodeRequest): Promise<{ Code: string; ExpiresAt: Date }>
    IssueSpent(request: EnrolmentCodeRequest): Promise<{ Code: string; ExpiresAt: Date }>
}

/** The hosts a placement goes to (HostRegistry). */
export interface ISchedulingHosts
{
    List(): readonly HostRecord[]
}

export interface PlacementSchedulerParts
{
    Placements: PlacementRegistry
    Hosts: ISchedulingHosts
    Queue: PlacementQueue
    Codes: IPlacementCodes
    Releases: IOfferedReleases
    Link: PlacementHiveLink
    Now?: () => Date
    Random?: (size: number) => Buffer
    /** Where a placement's failed step is logged (a fixed sentence, the placement id and the error's name). */
    Log?: (line: string) => void
}

/**
 * Moves hosted placements along (C5.1), one tick at a time:
 * - requested → scheduled on the host with the most free slots (the freshest first among equals) whose last report is
 *   at most two minutes old and healthy; a full or stale host is skipped and, with no host left, the placement stays
 *   requested. It installs the release the platform offers the tenant (version and chart digest); none offered, it
 *   waits too. The hive's label is `<tenant>-<4 base32>`, its host name `<label>.hives.pragmatic-tech.ai`, and its
 *   one-time code is issued for exactly the placement's tenant, level hosted and agent kind hive (bound to the
 *   placement, so it does not count against the client twice);
 * - every request owed to a host's queue is signed and published: a place (a new code each time, since the last one
 *   may have expired), an engine upgrade of a placed hive (a new placement version; its code is issued spent, since
 *   the hive is already enrolled) or a removal; a request that expired unpulled is owed again;
 * - a placed hive whose tenant is offered a newer release is upgraded (a new placement version, never a downgrade);
 * - every placed placement's hive link is re-applied (idempotent).
 * One tick at a time; a placement whose step fails is logged and retried on the next tick.
 */
export class PlacementScheduler
{
    public static readonly DefaultIntervalMs = 15_000
    private static readonly LabelAlphabet = 'abcdefghijklmnopqrstuvwxyz234567'
    private static readonly LabelCharacters = 4
    private static readonly LabelSeparator = '-'
    private static readonly LabelTries = 32
    private static readonly Mask = 31
    private static readonly FailedLogPrefix = '[placement-scheduler] a step failed for placement '
    private static readonly LogSeparator = ': '
    private static readonly UnknownErrorName = 'Error'
    private static readonly NoLabelText = 'no free hive label was found'

    private running: Promise<void> | undefined
    private timer: ReturnType<typeof setInterval> | undefined

    public constructor(private readonly parts: PlacementSchedulerParts)
    {
    }

    /** Ticks every `intervalMs` (unref'd, so it never holds the process open). */
    public Start(intervalMs: number = PlacementScheduler.DefaultIntervalMs): void
    {
        if (this.timer !== undefined)
        {
            return
        }
        this.timer = setInterval(() => { void this.Tick() }, intervalMs)
        this.timer.unref()
    }

    public Stop(): void
    {
        if (this.timer !== undefined)
        {
            clearInterval(this.timer)
            this.timer = undefined
        }
    }

    /** One pass; a tick asked while one runs joins it. */
    public Tick(): Promise<void>
    {
        if (this.running === undefined)
        {
            this.running = this.Pass().finally(() => { this.running = undefined })
        }
        return this.running
    }

    private async Pass(): Promise<void>
    {
        const P = this.parts.Placements
        for (const placement of P.List())
        {
            await this.Guarded(placement, () => this.RepublishExpired(placement))
        }
        for (const placement of P.Requested().slice().sort((a, b) => a.requestedAt.localeCompare(b.requestedAt)))
        {
            await this.Guarded(placement, () => this.ScheduleOne(placement))
        }
        for (const placement of P.Placed())
        {
            await this.Guarded(placement, () => this.UpgradeOne(placement))
        }
        for (const placement of P.Owed())
        {
            await this.Guarded(placement, () => this.Publish(placement))
        }
        for (const placement of P.Placed())
        {
            await this.Guarded(placement, () => this.parts.Link.Apply(placement))
        }
    }

    private async Guarded(placement: PlacementRecord, step: () => Promise<unknown>): Promise<void>
    {
        const S = PlacementScheduler
        try
        {
            await step()
        }
        catch (error)
        {
            const name = error instanceof Error ? error.name : S.UnknownErrorName
            ;(this.parts.Log ?? (line => console.error(line)))(S.FailedLogPrefix + placement.id + S.LogSeparator + name)
        }
    }

    /** A published request that expired before its host pulled it is owed again (a confirmed placement needs none). */
    private async RepublishExpired(placement: PlacementRecord): Promise<void>
    {
        if (placement.requestSequence === undefined || placement.hostId === undefined || this.parts.Queue.Holds(placement.hostId, placement.requestSequence))
        {
            return
        }
        const pendingUpgrade = placement.state === PlacementState.Placed && placement.placedEngineVersion !== placement.engineVersion && placement.upgradeFailure === undefined
        if (placement.state === PlacementState.Scheduled || placement.state === PlacementState.Removing || pendingUpgrade)
        {
            await this.parts.Placements.Republish(placement.id)
        }
    }

    private async ScheduleOne(placement: PlacementRecord): Promise<void>
    {
        const host = this.PickHost()
        const release = this.parts.Releases.OfferedFor(placement.tenantId)
        if (host === undefined || release === undefined)
        {
            return
        }
        const label = this.NewLabel(placement.tenantId)
        await this.parts.Placements.Schedule(placement.id, {
            HostId: host.id, Label: label, HiveHostName: ConsoleAddress.SubdomainOf(label), EngineVersion: release.Version, ChartDigest: release.ChartDigest,
        })
    }

    private async UpgradeOne(placement: PlacementRecord): Promise<void>
    {
        const release = this.parts.Releases.OfferedFor(placement.tenantId)
        if (release === undefined || placement.engineVersion === undefined || VersionOrder.Compare(release.Version, placement.engineVersion) <= 0)
        {
            return
        }
        await this.parts.Placements.Upgrade(placement.id, release.Version, release.ChartDigest)
    }

    /** Signs and enqueues the placement's owed request, then records its sequence. */
    private async Publish(placement: PlacementRecord): Promise<void>
    {
        const hostId = placement.hostId
        if (hostId === undefined)
        {
            return
        }
        const request = await this.RequestFor(placement)
        if (request === undefined)
        {
            return
        }
        const sequence = await this.parts.Queue.Publish(hostId, request)
        await this.parts.Placements.RecordPublished(placement.id, sequence)
    }

    private async RequestFor(placement: PlacementRecord): Promise<PlacementRequest | undefined>
    {
        if (placement.state === PlacementState.Removing)
        {
            return PlacementRequest.Remove(placement.id, placement.tenantId)
        }
        if (placement.label === undefined || placement.hiveHostName === undefined || placement.engineVersion === undefined || placement.chartDigest === undefined)
        {
            return undefined
        }
        const codeRequest: EnrolmentCodeRequest = {
            ClientId: placement.clientId, TenantId: placement.tenantId, Level: HiveLevel.Hosted, AgentKind: EnrolmentAgentKind.Hive,
            IssuedBy: placement.requestedBy, PlacementId: placement.id,
        }
        // An upgrade installs nothing that enrols: the hive is enrolled already, so its code can never be redeemed.
        const code = placement.state === PlacementState.Placed ? await this.parts.Codes.IssueSpent(codeRequest) : await this.parts.Codes.Issue(codeRequest)
        return PlacementRequest.Place({
            PlacementId: placement.id, Tenant: placement.tenantId, EnrolmentCode: code.Code, EngineVersion: placement.engineVersion,
            ChartDigest: placement.chartDigest, HiveHostName: placement.hiveHostName,
        })
    }

    /** The freshest host with the most free slots, or undefined when every host is full or stale. */
    private PickHost(): HostRecord | undefined
    {
        const now = (this.parts.Now ?? (() => new Date()))()
        const candidates = this.parts.Hosts.List()
            .filter(host => HostRegistry.IsFresh(host, now))
            .map(host => ({ host, free: HostRegistry.FreeSlots(host, this.parts.Placements.HoldingSlotOn(host.id).length) }))
            .filter(candidate => candidate.free > 0)
            .sort((a, b) => b.free - a.free || (b.host.lastReportAt ?? '').localeCompare(a.host.lastReportAt ?? ''))
        return candidates[0]?.host
    }

    private NewLabel(tenantId: string): string
    {
        const S = PlacementScheduler
        const random = this.parts.Random ?? randomBytes
        for (let attempt = 0; attempt < S.LabelTries; attempt++)
        {
            const bytes = random(S.LabelCharacters)
            let suffix = ''
            for (let i = 0; i < S.LabelCharacters; i++)
            {
                suffix += S.LabelAlphabet[(bytes[i] as number) & S.Mask]
            }
            const label = tenantId + S.LabelSeparator + suffix
            if (!this.parts.Placements.LabelTaken(label))
            {
                return label
            }
        }
        throw new Error(S.NoLabelText)
    }
}
