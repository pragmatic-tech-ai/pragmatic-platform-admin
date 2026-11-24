import type { HiveRecord } from '@pragmatic-tech-ai/pragmatic-tenant-plane'
import { PlatformHiveRecords, type PlatformHiveRecord } from './platform-records.js'

/** A push (kubectl, an install, the admin proxy, a tunnel) to a hive the platform manages only by pulled intents. */
export class HiveNotPushableError extends Error
{
    public static readonly Code = 'hive-not-pushable'
    private static readonly ErrorName = 'HiveNotPushableError'
    private static readonly Text = 'This hive is managed by pulled intents: the platform never pushes to it.'

    public constructor()
    {
        super(HiveNotPushableError.Text)
        this.name = HiveNotPushableError.ErrorName
    }
}

/**
 * How the platform may reach a hive (C3.4): push only to Hosted hives and to records without a level (every such hive
 * is on our machines); an Enrolled or Delegated hive is managed only by the intents it pulls. Every push entry point
 * asks Require first.
 */
export class HiveReach
{
    private constructor()
    {
    }

    public static Pushable(hive: HiveRecord): boolean
    {
        return PlatformHiveRecords.Pushable(hive as PlatformHiveRecord)
    }

    /** Throws HiveNotPushableError (code `hive-not-pushable`) unless the platform may push to the hive. */
    public static Require(hive: HiveRecord): void
    {
        if (!HiveReach.Pushable(hive))
        {
            throw new HiveNotPushableError()
        }
    }
}
