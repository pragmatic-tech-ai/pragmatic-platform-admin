import { IntentActionKind, IntentDecisionKind, IntentProgress, Pull, type IntentDecision, type IntentStatus } from '@pragmatic-tech-ai/pragmatic-hive-protocol'
import type { IntentRecord, IntentStore } from './intent-record.js'

/** One pull's answer: the intents to serve, in sequence order, and the cursor to pull after next. */
export class IntentPage
{
    public constructor(public readonly Items: readonly IntentRecord[], public readonly Next: number)
    {
    }
}

/** Why a decision the hive sent is not recorded. */
export enum DecisionRefusal
{
    Expired = 'expired',
    Superseded = 'superseded',
    Settled = 'settled',
    AlreadyDecided = 'already-decided',
}

/**
 * Each hive's intents in sequence order (C3.4): what a pull after a cursor is served, where each intent stands, and the
 * decisions and progress the hive sent back. Served are the open intents (neither applied, rejected, failed, expired
 * nor superseded, and not past their expiry). A cursor beyond the hive's newest sequence is one the platform no longer
 * knows (a restore from an older backup): the answer then starts at the hive's oldest open intent, so nothing open is
 * ever skipped. Every change re-reads the record and writes it in one synchronous step (the record store stages in
 * memory before it persists), so no change is lost to another made meanwhile.
 */
export class IntentOutbox
{
    private static readonly ComponentField = 'Component'
    private static readonly ImageDigestField = 'ImageDigest'
    private static readonly Terminal: ReadonlySet<IntentProgress> = new Set([IntentProgress.Applied, IntentProgress.Rejected, IntentProgress.Failed, IntentProgress.Expired])

    public constructor(private readonly store: IntentStore, private readonly now: () => Date = () => new Date())
    {
    }

    public Get(id: string): IntentRecord | undefined
    {
        return this.store.Get(id)
    }

    /** The hive's intents, oldest first. */
    public ForHive(hiveId: string): readonly IntentRecord[]
    {
        return this.store.List().filter(record => record.hiveId === hiveId).sort((a, b) => a.sequence - b.sequence)
    }

    /** The hive's open intents, oldest first. */
    public OpenForHive(hiveId: string): readonly IntentRecord[]
    {
        return this.ForHive(hiveId).filter(record => this.IsOpen(record))
    }

    public MaxSequence(hiveId: string): number
    {
        return this.ForHive(hiveId).at(-1)?.sequence ?? 0
    }

    public async Add(record: IntentRecord): Promise<void>
    {
        await this.store.Put(record)
    }

    /** Changes the record as it is now (re-read here); undefined when there is none. */
    public async Update(id: string, change: (current: IntentRecord) => IntentRecord): Promise<IntentRecord | undefined>
    {
        const current = this.store.Get(id)
        if (current === undefined)
        {
            return undefined
        }
        const next = change(current)
        await this.store.Put(next)
        return next
    }

    /** Waiting for the hive or the customer: not applied, rejected, failed or expired, not superseded, not past its expiry. */
    public IsOpen(record: IntentRecord): boolean
    {
        return !IntentOutbox.IsTerminal(record) && record.supersededBy === null && !this.IsExpired(record)
    }

    public IsExpired(record: IntentRecord): boolean
    {
        return Date.parse(record.expiresAt) <= this.now().getTime()
    }

    public static IsTerminal(record: IntentRecord): boolean
    {
        return record.progress !== null && IntentOutbox.Terminal.has(record.progress)
    }

    /** The hive's open component-at-version intent for `component`, newest first. */
    public OpenComponentIntents(hiveId: string, component: string): readonly IntentRecord[]
    {
        return this.OpenForHive(hiveId).filter(record => record.kind === IntentActionKind.ComponentAtVersion && record.action[IntentOutbox.ComponentField] === component).reverse()
    }

    /** The image digest the hive last applied for `component` by intent, when it ever did. */
    public AppliedImageOf(hiveId: string, component: string): string | undefined
    {
        const O = IntentOutbox
        const applied = this.ForHive(hiveId).filter(record => record.kind === IntentActionKind.ComponentAtVersion && record.progress === IntentProgress.Applied && record.action[O.ComponentField] === component)
        const last = applied.at(-1)
        return last === undefined ? undefined : IntentOutbox.ImageDigestOf(last)
    }

    /** A component-at-version intent's image digest (undefined for another kind). */
    public static ImageDigestOf(record: IntentRecord): string | undefined
    {
        const digest = record.action[IntentOutbox.ImageDigestField]
        return typeof digest === 'string' ? digest : undefined
    }

    /**
     * The open intents to serve to a pull after `cursor` (at most `max`, never more than a batch carries): first every
     * open intent the hive never reported (whatever its number: one numbered at or below a cursor the platform forgot in a
     * restore is still served), in sequence order, then the open intents numbered above the cursor; the next cursor is
     * the larger of the hive's and the highest number served. The agent skips the ids it already keeps, and its report
     * moves a served intent out of the unreported ones, so a backlog larger than a batch is paged through.
     */
    public After(hiveId: string, cursor: number | null, max: number = Pull.MaxItems): IntentPage
    {
        const limit = Math.min(Math.max(max, 1), Pull.MaxItems)
        const after = cursor ?? 0
        const open = this.ForHive(hiveId).filter(record => this.IsOpen(record))
        const unreported = open.filter(record => record.progress === null)
        const above = open.filter(record => record.progress !== null && record.sequence > after)
        const items = [...unreported, ...above].slice(0, limit)
        const next = items.reduce((highest, record) => Math.max(highest, record.sequence), after)
        return new IntentPage(items, next)
    }

    /** The progress a hive's report carried, onto that hive's own intents (an id of another hive's is ignored). */
    public async RecordProgress(hiveId: string, statuses: readonly IntentStatus[]): Promise<void>
    {
        for (const status of statuses)
        {
            await this.Update(status.IntentId, current => current.hiveId !== hiveId ? current : { ...current, progress: status.Progress, failure: status.Failure })
        }
    }

    /**
     * Why the decision may not be recorded on the intent as it is now, or undefined: an expired, superseded or settled
     * intent takes none, and a decided one only the same decision again (a re-sent answer).
     */
    public DecisionRefusalOf(record: IntentRecord, decision: IntentDecision): DecisionRefusal | undefined
    {
        if (record.decision !== null)
        {
            return record.decision.decision === decision.Decision ? undefined : DecisionRefusal.AlreadyDecided
        }
        if (record.supersededBy !== null)
        {
            return DecisionRefusal.Superseded
        }
        if (IntentOutbox.IsTerminal(record))
        {
            return DecisionRefusal.Settled
        }
        return this.IsExpired(record) ? DecisionRefusal.Expired : undefined
    }

    /** The customer's decision, recorded on the intent as it is now when DecisionRefusalOf allows it; a rejection is final. */
    public async RecordDecision(intentId: string, decision: IntentDecision): Promise<DecisionRefusal | undefined>
    {
        let refusal: DecisionRefusal | undefined
        await this.Update(intentId, current =>
        {
            refusal = this.DecisionRefusalOf(current, decision)
            if (refusal !== undefined || current.decision !== null)
            {
                return current
            }
            const rejected = decision.Decision === IntentDecisionKind.Rejected
            return {
                ...current,
                decision: { decision: decision.Decision, realm: decision.Approver.Realm, subject: decision.Approver.Subject, decidedAt: decision.DecidedAt.toISOString() },
                progress: rejected ? IntentProgress.Rejected : current.progress,
                failure: rejected ? null : current.failure,
            }
        })
        return refusal
    }
}
