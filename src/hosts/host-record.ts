import { JsonRecordStore, type IRecordMap } from '@pragmatic-tech-ai/pragmatic-tenant-plane'
import type { ClusterKind, HostReportJson } from '@pragmatic-tech-ai/pragmatic-hive-protocol'

/**
 * A hosting machine's host agent, enrolled once with an operator's host code (C5.1): its machine name, the cluster
 * technology it runs, its mesh address (where the platform reaches the clusters it creates), its Ed25519 public key
 * (the private half never left the machine) and key id, its version, the platform sealing key it was handed (by key
 * id), who issued its code, its latest capacity report and the last sequence of its placement queue.
 */
export type HostRecord = {
    id: string
    machine: string
    clusterKind: ClusterKind
    meshAddress: string
    publicKey: string
    keyId: string
    agentVersion: string
    /** The key id of the platform sealing key the host seals cluster credentials to. */
    sealingKeyId: string
    enrolledAt: string
    /** The operator whose host code enrolled it (`operator:<email>`). */
    enrolledBy: string
    /** The newest capacity report, as the host signed it, and when it arrived. */
    lastReport?: HostReportJson
    lastReportAt?: string
    /** The sequence of the newest item in the host's placement queue (0: none yet). */
    lastSequence?: number
}

export class HostStore extends JsonRecordStore<HostRecord>
{
    public static readonly RootKey = 'hosts'

    public constructor(location: string | IRecordMap<HostRecord>)
    {
        super(location, HostStore.RootKey)
    }
}
