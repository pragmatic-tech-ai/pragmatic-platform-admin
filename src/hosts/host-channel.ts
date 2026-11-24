import type { EnvelopeSigner, SealingKeyPair, SigningPublicKey } from '@pragmatic-tech-ai/pragmatic-hive-protocol'
import type { IEnrolmentCodes } from '../hive-channel/hive-enrolment-handler.js'
import type { IAgentMessageHandler } from '../hive-channel/platform-agent-exchange.js'
import type { IOfferedReleases } from '../placement/offered-releases.js'
import type { PlacementHiveLink } from '../placement/placement-hive-link.js'
import { PlacementPullHandler } from '../placement/placement-pull-handler.js'
import { PlacementQueue, type PlacementQueueStore } from '../placement/placement-queue.js'
import { PlacementResultHandler } from '../placement/placement-result-handler.js'
import type { PlacementRegistry } from '../placement/placement-registry.js'
import { PlacementScheduler, type IPlacementCodes } from '../placement/placement-scheduler.js'
import { CredentialHandoverHandler } from './credential-handover-handler.js'
import { HostEnrolmentHandler } from './host-enrolment-handler.js'
import type { HostRegistry } from './host-registry.js'
import { HostReportHandler } from './host-report-handler.js'
import { PlatformSealingKey } from './platform-sealing-key.js'

/** Where opened cluster credentials live: the platform's sealed secret store. */
export interface IClusterCredentialStore
{
    Put(ref: string, value: Buffer): Promise<void>
    Delete(ref: string): Promise<void>
}

/** What the host side of the agent exchange is composed from. */
export interface HostChannelParts
{
    Hosts: HostRegistry
    Placements: PlacementRegistry
    QueueStore: PlacementQueueStore
    Codes: IEnrolmentCodes & IPlacementCodes
    Releases: IOfferedReleases
    Link: PlacementHiveLink
    Credentials: IClusterCredentialStore
    /** PRAGMATIC_ADMIN_SEALING_KEY_FILE's key; undefined: the console takes no hosts. */
    SealingKey: SealingKeyPair | undefined
    Now?: () => Date
    Warn?: (line: string) => void
}

/**
 * The host side of the signed agent exchange (C5.1), composed beside the hive side (HiveChannel.Compose): host
 * enrolment (with the platform's X25519 sealing key), capacity reports, placement pulls from each host's queue,
 * placement results and sealed credential handovers, and the PlacementScheduler that fills the queues. Without the
 * sealing key the console takes no hosts: no host kind is handled and nothing is scheduled (a start warning says so).
 */
export class HostChannel
{
    private scheduler: PlacementScheduler | undefined

    public constructor(private readonly parts: HostChannelParts)
    {
    }

    public get Registry(): HostRegistry
    {
        return this.parts.Hosts
    }

    public get Link(): PlacementHiveLink
    {
        return this.parts.Link
    }

    /** The scheduler, once Handlers composed it (undefined while hosts are off). */
    public get Scheduler(): PlacementScheduler | undefined
    {
        return this.scheduler
    }

    /** The host handlers under the platform's signer and trust root; none (warned) without the sealing key. */
    public Handlers(signer: EnvelopeSigner, trustRoot: SigningPublicKey, channelUrl: string): IAgentMessageHandler[]
    {
        const parts = this.parts
        if (parts.SealingKey === undefined)
        {
            (parts.Warn ?? (line => console.warn(line)))(PlatformSealingKey.OffWarning)
            return []
        }
        const queue = new PlacementQueue(parts.QueueStore, parts.Hosts, signer, parts.Now)
        this.scheduler = new PlacementScheduler({
            Placements: parts.Placements, Hosts: parts.Hosts, Queue: queue, Codes: parts.Codes, Releases: parts.Releases, Link: parts.Link,
            ...(parts.Now === undefined ? {} : { Now: parts.Now }),
        })
        return [
            new HostEnrolmentHandler({ Codes: parts.Codes, Hosts: parts.Hosts, TrustRoot: trustRoot, SealingKey: parts.SealingKey.PublicKey, ChannelUrl: channelUrl }),
            new HostReportHandler(parts.Hosts),
            new PlacementPullHandler(parts.Hosts, queue),
            new PlacementResultHandler(parts.Placements, parts.Link, parts.Credentials),
            new CredentialHandoverHandler(parts.Placements, parts.Credentials, parts.SealingKey),
        ]
    }
}
