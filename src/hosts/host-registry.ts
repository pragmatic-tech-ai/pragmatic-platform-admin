import { randomBytes } from 'node:crypto'
import { HostHealth, PlacementState as HostPlacementState, type HostReport } from '@pragmatic-tech-ai/pragmatic-hive-protocol'
import type { HostRecord, HostStore } from './host-record.js'

/** No host record by that id. */
export class UnknownHostError extends Error
{
    private static readonly ErrorName = 'UnknownHostError'
    private static readonly MessagePrefix = 'Unknown host: '

    public constructor(id: string)
    {
        super(UnknownHostError.MessagePrefix + id)
        this.name = UnknownHostError.ErrorName
    }
}

/** No free host id after the allotted tries (a collision every time: practically impossible). */
export class HostIdExhaustedError extends Error
{
    private static readonly ErrorName = 'HostIdExhaustedError'
    private static readonly Text = 'no free host id was found'

    public constructor()
    {
        super(HostIdExhaustedError.Text)
        this.name = HostIdExhaustedError.ErrorName
    }
}

/** What an enrolling host is recorded with. */
export type HostEnrolment = Omit<HostRecord, 'id' | 'enrolledAt' | 'lastReport' | 'lastReportAt' | 'lastSequence'>

/**
 * The enrolled host agents (C5.1). Ids are `hs` plus 10 lowercase base32 characters, a DNS label. A host is usable for
 * new placements when its newest report is at most two minutes old and healthy; its free slots are its reported hive
 * slots less the placements that hold one (those the platform scheduled there, or those the host reports, whichever is
 * more). Every write stages before its first await, so sequences are never handed out twice.
 */
export class HostRegistry
{
    public static readonly IdPrefix = 'hs'
    public static readonly IdPattern = /^hs[a-z2-7]{10}$/
    /** A report older than this makes the host stale (it is skipped by the scheduler). */
    public static readonly FreshMs = 2 * 60 * 1000
    private static readonly Alphabet = 'abcdefghijklmnopqrstuvwxyz234567'
    private static readonly IdCharacters = 10
    private static readonly MaxTries = 8
    private static readonly Mask = 31

    public constructor(private readonly store: HostStore, private readonly now: () => Date = () => new Date(), private readonly random: (size: number) => Buffer = randomBytes)
    {
    }

    public Get(id: string): HostRecord | undefined
    {
        return this.store.Get(id)
    }

    public List(): readonly HostRecord[]
    {
        return this.store.List()
    }

    public ByKeyId(keyId: string): HostRecord | undefined
    {
        return this.store.List().find(host => host.keyId === keyId)
    }

    /** Records a new host under a fresh id. */
    public async Enrol(enrolment: HostEnrolment): Promise<HostRecord>
    {
        const record: HostRecord = { ...enrolment, id: this.NewId(), enrolledAt: this.now().toISOString() }
        await this.store.Put(record)
        return record
    }

    /** The lost-answer recovery: the same host (id, key, queue) with this enrolment's details. */
    public async ReEnrol(id: string, enrolment: HostEnrolment): Promise<HostRecord>
    {
        const host = this.Require(id)
        const record: HostRecord = { ...host, ...enrolment, id: host.id, enrolledAt: this.now().toISOString() }
        await this.store.Put(record)
        return record
    }

    public async RecordReport(id: string, report: HostReport): Promise<HostRecord>
    {
        const host = this.Require(id)
        const record: HostRecord = { ...host, lastReport: report.ToJson(), lastReportAt: this.now().toISOString(), agentVersion: report.AgentVersion }
        await this.store.Put(record)
        return record
    }

    /**
     * The next sequence of the host's placement queue, taken (staged before the first await): one more than the last,
     * and never below the clock's milliseconds, so a platform restored from an older backup (its last sequence behind
     * the host's cursor) still numbers new requests above every cursor the host holds.
     */
    public async TakeSequence(id: string): Promise<number>
    {
        const host = this.Require(id)
        const sequence = Math.max((host.lastSequence ?? 0) + 1, this.now().getTime())
        await this.store.Put({ ...host, lastSequence: sequence })
        return sequence
    }

    /** Whether the host reported at most two minutes ago, healthy. */
    public static IsFresh(host: HostRecord, now: Date): boolean
    {
        if (host.lastReport === undefined || host.lastReportAt === undefined)
        {
            return false
        }
        return host.lastReport.Health === HostHealth.Healthy && now.getTime() - Date.parse(host.lastReportAt) <= HostRegistry.FreshMs
    }

    /** The reported hive slots less the placements holding one (the platform's count or the host's, whichever is more; a
     *  placement the host reports failed holds none). */
    public static FreeSlots(host: HostRecord, holding: number): number
    {
        const report = host.lastReport
        if (report === undefined)
        {
            return 0
        }
        const reported = report.Placements.filter(placement => placement.State !== HostPlacementState.Failed).length
        return Math.max(0, report.HiveSlots - Math.max(holding, reported))
    }

    private Require(id: string): HostRecord
    {
        const host = this.store.Get(id)
        if (host === undefined)
        {
            throw new UnknownHostError(id)
        }
        return host
    }

    private NewId(): string
    {
        const H = HostRegistry
        for (let attempt = 0; attempt < H.MaxTries; attempt++)
        {
            const bytes = this.random(H.IdCharacters)
            let id = H.IdPrefix
            for (let i = 0; i < H.IdCharacters; i++)
            {
                id += H.Alphabet[(bytes[i] as number) & H.Mask]
            }
            if (this.store.Get(id) === undefined)
            {
                return id
            }
        }
        throw new HostIdExhaustedError()
    }
}
