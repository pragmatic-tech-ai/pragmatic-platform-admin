import { ComponentAtVersion } from '@pragmatic-tech-ai/pragmatic-hive-protocol'
import { ReleaseApp } from '@pragmatic-tech-ai/pragmatic-release-toolkit'
import type { ManifestRecord } from '@pragmatic-tech-ai/pragmatic-tenant-plane'
import type { IReleaseIntents } from '../platform-deployment-registry.js'
import type { PlatformHiveRecord } from '../platform-records.js'
import type { IntentPublisher } from './intent-publisher.js'
import { IntentOutbox } from './intent-outbox.js'

/**
 * A release selection for a hive managed by pulled intents (C3.4): one signed component-at-version intent per engine
 * component (the console, the sign-in service, Postgres, the hive agent) whose image digest in the new release is not
 * the one the hive runs: the last it applied by intent, else the one of the release it enrolled at. An open intent that
 * already asks for that digest is kept (a retried selection publishes nothing twice); an older open intent for the
 * component asking for another digest is superseded by the new one. The hive agent's own upgrade is published last, so
 * the agent applies it after the others. A component the new release carries no image or descriptor digest for is not
 * announced (a release from before component descriptors cannot be pulled). Environment images move with the console's
 * release descriptors, not here.
 */
export class RolloutIntents implements IReleaseIntents
{
    /** In apply order: the agent itself last. */
    public static readonly EngineComponents: readonly ReleaseApp[] = [ReleaseApp.TenantAdmin, ReleaseApp.TenantIdp, ReleaseApp.Postgres, ReleaseApp.HiveAgent]
    public static readonly PublishedBy = 'platform:release-rollout'

    public constructor(private readonly publisher: IntentPublisher, private readonly outbox: IntentOutbox)
    {
    }

    public PublishRelease(hive: PlatformHiveRecord, installed: ManifestRecord | undefined, to: ManifestRecord): Promise<readonly string[]>
    {
        // In the hive's turn: the open-intent check and its publish cannot interleave with another selection.
        return this.publisher.ForHive(hive.id, () => this.PublishInTurn(hive, installed, to))
    }

    private async PublishInTurn(hive: PlatformHiveRecord, installed: ManifestRecord | undefined, to: ManifestRecord): Promise<readonly string[]>
    {
        const published: string[] = []
        for (const app of RolloutIntents.EngineComponents)
        {
            const image = to.release?.images?.[app]
            if (image === undefined || image.componentDigest === undefined)
            {
                continue
            }
            const runs = this.outbox.AppliedImageOf(hive.id, app) ?? installed?.release?.images?.[app]?.digest
            const open = this.outbox.OpenComponentIntents(hive.id, app)
            if (open.some(record => IntentOutbox.ImageDigestOf(record) === image.digest))
            {
                continue
            }
            if (runs === image.digest && open.length === 0)
            {
                continue
            }
            const record = await this.publisher.PublishInTurn(hive.id, new ComponentAtVersion(app, to.id, image.digest, image.componentDigest, null), RolloutIntents.PublishedBy)
            for (const older of open)
            {
                await this.publisher.Supersede(older.id, record.id)
            }
            published.push(record.id)
        }
        return published
    }
}
