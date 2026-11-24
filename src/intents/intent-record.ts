import type { HiveLevel, IntentActionKind, IntentDecisionKind, IntentFailure, IntentProgress } from '@pragmatic-tech-ai/pragmatic-hive-protocol'
import { JsonRecordStore, type IRecordMap } from '@pragmatic-tech-ai/pragmatic-tenant-plane'

/** The customer's answer to an Enrolled intent, as the hive's signed IntentDecision carried it. */
export type IntentDecisionRecord = {
    decision: IntentDecisionKind
    /** The approving realm subject (realm id and the subject its sign-in issued; never a name or an email). */
    realm: string
    subject: string
    decidedAt: string
}

/**
 * One signed intent for one hive (C3.4): its id, the hive, its place in the hive's sequence, the level it was issued
 * under, the action, the envelope exactly as signed (wire text, served verbatim to the hive's pulls) and its digest, when
 * it was issued and expires, who published it, and from the hive's reports its progress (a failure code when it
 * failed) and the customer's decision. A reissued intent names the one that replaced it.
 */
export type IntentRecord = {
    id: string
    hiveId: string
    sequence: number
    level: HiveLevel
    kind: IntentActionKind
    action: Record<string, unknown>
    envelope: string
    digest: string
    issuedAt: string
    expiresAt: string
    /** `operator:<email>`, `customer:<subject key>` or `platform:<what>` (a release rollout). */
    publishedBy: string
    progress: IntentProgress | null
    failure: IntentFailure | null
    decision: IntentDecisionRecord | null
    supersededBy: string | null
    /** The intent this one reissues, when it does. */
    reissues: string | null
}

/** The `hive_intents` registry. */
export class IntentStore extends JsonRecordStore<IntentRecord>
{
    public static readonly RootKey = 'hiveIntents'

    public constructor(location: string | IRecordMap<IntentRecord>)
    {
        super(location, IntentStore.RootKey)
    }
}
