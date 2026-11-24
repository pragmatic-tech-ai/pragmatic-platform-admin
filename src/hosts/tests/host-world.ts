import { randomBytes } from 'node:crypto'
import { HiveLevel as CustomerHiveLevel } from '@pragmatic-tech-ai/pragmatic-customer-api-contract'
import {
    EnvelopeSigner, EnvelopeVerifier, HostHealth, HostReport, InMemoryNonceLedger, Participant, PlacementStatus, Resources, SealingKeyPair, SigningKeyPair,
    type PlacementState as HostPlacementState,
} from '@pragmatic-tech-ai/pragmatic-hive-protocol'
import { FakeClock, FakeHostAgent } from '@pragmatic-tech-ai/pragmatic-hive-protocol/testing'
import { MemoryRecordMap } from '@pragmatic-tech-ai/pragmatic-tenant-plane'
import { ClientRegistry } from '../../client-registry.js'
import { EnrolmentCodeIssuer } from '../../enrolment/enrolment-code-issuer.js'
import { EnrolmentCodeRegistry, type EnrolmentCodeRecord } from '../../enrolment/enrolment-code-record.js'
import { HiveObservationRegistry, type HiveObservationRecord } from '../../hive-observation-record.js'
import { HiveRegistry } from '../../hive-registry.js'
import { HiveEnrolmentHandler } from '../../hive-channel/hive-enrolment-handler.js'
import { HiveIdAllocator } from '../../hive-channel/hive-id-allocator.js'
import { HiveReportHandler } from '../../hive-channel/hive-report-handler.js'
import { PlatformAgentExchange } from '../../hive-channel/platform-agent-exchange.js'
import { PlatformKeyDirectory } from '../../hive-channel/platform-key-directory.js'
import { WorldChannel } from '../../hive-channel/tests/hive-channel-world.js'
import type { OfferedRelease, IOfferedReleases } from '../../placement/offered-releases.js'
import { PlacementHiveLink } from '../../placement/placement-hive-link.js'
import { PlacementQueueStore, type PlacementQueueRecord } from '../../placement/placement-queue.js'
import type { PlacementRecord } from '../../placement/placement-record.js'
import { PlacementStore } from '../../placement/placement-record.js'
import { PlacementRegistry } from '../../placement/placement-registry.js'
import type { PlacementScheduler } from '../../placement/placement-scheduler.js'
import { PlatformDirectory } from '../../platform-directory.js'
import type { ClientRecord, PlatformTenantRecord } from '../../platform-records.js'
import { SealedSecretStore } from '../../sealed-secret-store.js'
import { TenantRegistry } from '../../tenant-registry.js'
import { HostChannel } from '../host-channel.js'
import { HostStore, type HostRecord } from '../host-record.js'
import { HostRegistry } from '../host-registry.js'

/** Kubeconfigs of the shape a host agent hands over (ClusterCredentialIssuer.Kubeconfig), and broken ones. */
export class HostKubeconfigs
{
    public static readonly Port = 16444
    public static readonly Ca = Buffer.from(['-----BEGIN CERTIFICATE-----', 'MIIBfakecertificate', '-----END CERTIFICATE-----', ''].join('\n')).toString('base64')
    public static readonly Token = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJwcmFnbWF0aWMifQ.c2lnbmF0dXJl'

    /** The agent's kubeconfig object; `mutate` breaks it for a refusal case. */
    public static Object(port: number = HostKubeconfigs.Port, host: string = FakeHostAgent.DefaultMeshAddress): Record<string, unknown>
    {
        const K = HostKubeconfigs
        return {
            apiVersion: 'v1',
            kind: 'Config',
            clusters: [{ name: 'clusters-pl', cluster: { server: 'https://' + host + ':' + String(port), 'certificate-authority-data': K.Ca } }],
            users: [{ name: 'pragmatic-platform', user: { token: K.Token } }],
            contexts: [{ name: 'pragmatic-platform', context: { cluster: 'clusters-pl', user: 'pragmatic-platform' } }],
            'current-context': 'pragmatic-platform',
        }
    }

    public static Valid(port: number = HostKubeconfigs.Port, tag: string = ''): Buffer
    {
        const value = HostKubeconfigs.Object(port)
        const users = value.users as Array<{ user: { token: string } }>
        ;(users[0] as { user: { token: string } }).user.token = HostKubeconfigs.Token + tag
        return Buffer.from(JSON.stringify(value))
    }

    public static Of(value: unknown): Buffer
    {
        return Buffer.from(JSON.stringify(value))
    }
}

/** The release a test offers every tenant; unset, none. */
export class FakeOfferedReleases implements IOfferedReleases
{
    public Offered: OfferedRelease | undefined = { Version: HostWorld.EngineVersion, ChartDigest: HostWorld.ChartDigest }

    public OfferedFor(_tenantId: string): OfferedRelease | undefined
    {
        return this.Offered
    }
}

/**
 * The platform's side of the agent channel with hosts on (C5.1), over in-memory stores: the real directory, code
 * issuer, placement and host registries, placement queue, sealed secret store, hive link and HostChannel, composed into
 * one PlatformAgentExchange beside the hive handlers, as HiveChannel.Compose does.
 */
export class HostWorld
{
    public static readonly ClientId = 'acme'
    public static readonly TenantA = 'acme'
    public static readonly TenantB = 'globex'
    public static readonly RequestedBy = 'https://login.example.test/realms/central\nsub-1'
    public static readonly Operator = 'operator:ops@pragmatic.test'
    public static readonly ChannelUrl = 'https://agent.pragmatic.test'
    public static readonly EngineVersion = '0.1.0-early.20'
    public static readonly NewerVersion = '0.1.0-early.21'
    public static readonly ChartDigest = 'sha256:' + 'a'.repeat(64)
    public static readonly NewerChartDigest = 'sha256:' + 'b'.repeat(64)
    public static readonly Machine = 'hive-laptop'
    public static readonly Slots = 4
    public static readonly MasterKeyBytes = 32

    public readonly Clock = new FakeClock()
    public readonly TrustRoot = SigningKeyPair.Generate()
    public readonly SealingKey = SealingKeyPair.Generate()
    public readonly Releases = new FakeOfferedReleases()
    public readonly Logs: string[] = []
    public Directory!: PlatformDirectory
    public Codes!: EnrolmentCodeIssuer
    public CodeRecords!: EnrolmentCodeRegistry
    public Placements!: PlacementRegistry
    public Hosts!: HostRegistry
    public QueueStore!: PlacementQueueStore
    public HostStore!: HostStore
    /** The label draws (PlacementScheduler.Random); undefined: crypto random. */
    public Random: ((size: number) => Buffer) | undefined
    public Sealed!: SealedSecretStore
    public Link!: PlacementHiveLink
    public HostChannel!: HostChannel
    public Exchange!: PlatformAgentExchange
    public Channel!: WorldChannel
    public Observations!: HiveObservationRegistry

    public static async Create(withSealingKey: boolean = true): Promise<HostWorld>
    {
        const world = new HostWorld()
        await world.Build(withSealingKey)
        return world
    }

    public get Scheduler(): PlacementScheduler
    {
        const scheduler = this.HostChannel.Scheduler
        if (scheduler === undefined)
        {
            throw new Error('hosts are off in this world')
        }
        return scheduler
    }

    public async HostCode(): Promise<string>
    {
        return (await this.Codes.IssueHostCode(HostWorld.Operator)).Code
    }

    /** A host agent enrolled with a fresh host code. */
    public async EnrolledHost(machine: string = HostWorld.Machine): Promise<FakeHostAgent>
    {
        const agent = new FakeHostAgent(this.Channel, this.Clock, this.TrustRoot.PublicKey)
        await agent.Enrol(await this.HostCode(), machine)
        return agent
    }

    public static Report(slots: number = HostWorld.Slots, health: HostHealth = HostHealth.Healthy, placements: ReadonlyArray<[string, HostPlacementState]> = []): HostReport
    {
        const capacity = new Resources(8000, 32768, 500)
        return HostReport.Create({
            AgentVersion: '0.1.0', Health: health, Capacity: capacity, Allocatable: new Resources(6000, 24576, 400), HiveSlots: slots,
            Placements: placements.map(([id, state]) => new PlacementStatus(id, state)),
        })
    }

    /** A host enrolled and reporting `slots` free slots now. */
    public async ReportingHost(slots: number = HostWorld.Slots, machine: string = HostWorld.Machine): Promise<FakeHostAgent>
    {
        const agent = await this.EnrolledHost(machine)
        await agent.Report(HostWorld.Report(slots))
        return agent
    }

    public Request(tenant: string = HostWorld.TenantA): Promise<PlacementRecord>
    {
        return this.Placements.Request(HostWorld.ClientId, tenant, HostWorld.RequestedBy)
    }

    public Host(agent: FakeHostAgent): HostRecord
    {
        const host = this.Hosts.Get(agent.Self.Id)
        if (host === undefined)
        {
            throw new Error('host not enrolled')
        }
        return host
    }

    public Placement(id: string): PlacementRecord
    {
        const placement = this.Placements.Get(id)
        if (placement === undefined)
        {
            throw new Error('no placement ' + id)
        }
        return placement
    }

    public CodeRecord(predicate: (record: EnrolmentCodeRecord) => boolean): EnrolmentCodeRecord | undefined
    {
        return this.CodeRecords.List().find(predicate)
    }

    public Queue(): readonly PlacementQueueRecord[]
    {
        return this.QueueStore.List()
    }

    private async Build(withSealingKey: boolean): Promise<void>
    {
        const W = HostWorld
        const now = (): Date => this.Clock.Now()
        this.Directory = new PlatformDirectory(new ClientRegistry(new MemoryRecordMap<ClientRecord>()), new TenantRegistry(new MemoryRecordMap<PlatformTenantRecord>()), new HiveRegistry(new MemoryRecordMap()), { List: () => [] }, now)
        await this.Directory.Load()
        await this.Directory.RecordClient({ id: W.ClientId, displayName: 'Acme' })
        await this.Directory.CreateTenant({ id: W.TenantA, clientId: W.ClientId, displayName: 'Acme' })
        await this.Directory.CreateTenant({ id: W.TenantB, clientId: W.ClientId, displayName: 'Globex' })
        this.CodeRecords = new EnrolmentCodeRegistry(new MemoryRecordMap<EnrolmentCodeRecord>())
        await this.CodeRecords.Load()
        this.Codes = new EnrolmentCodeIssuer(this.CodeRecords, now)
        const placements = new PlacementStore(new MemoryRecordMap<PlacementRecord>())
        await placements.Load()
        this.Placements = new PlacementRegistry(placements, now)
        const hosts = new HostStore(new MemoryRecordMap<HostRecord>())
        await hosts.Load()
        this.HostStore = hosts
        this.Hosts = new HostRegistry(hosts, now)
        this.QueueStore = new PlacementQueueStore(new MemoryRecordMap<PlacementQueueRecord>())
        await this.QueueStore.Load()
        this.Sealed = await SealedSecretStore.Open(new MemoryRecordMap<string>(), Buffer.alloc(W.MasterKeyBytes, 7))
        this.Observations = new HiveObservationRegistry(new MemoryRecordMap<HiveObservationRecord>())
        await this.Observations.Load()
        this.Link = new PlacementHiveLink(this.Placements, this.Directory)
        this.HostChannel = new HostChannel({
            Hosts: this.Hosts, Placements: this.Placements, QueueStore: this.QueueStore, Codes: this.Codes, Releases: this.Releases, Link: this.Link,
            Credentials: this.Sealed, SealingKey: withSealingKey ? this.SealingKey : undefined, Hives: this.Directory, Now: now, Random: size => (this.Random ?? randomBytes)(size), Warn: line => this.Logs.push(line),
        })
        const verifier = new EnvelopeVerifier({ Self: Participant.Platform, Keys: new PlatformKeyDirectory(this.Directory, this.Hosts), Nonces: new InMemoryNonceLedger(this.Clock), Clock: this.Clock })
        const signer = new EnvelopeSigner(this.TrustRoot, Participant.Platform, this.Clock)
        const ids = new HiveIdAllocator(id => this.Directory.GetHive(id) !== undefined)
        this.Exchange = new PlatformAgentExchange(verifier, signer, [
            new HiveEnrolmentHandler({ Codes: this.Codes, Hives: this.Directory, Reports: this.Observations, Ids: ids, TrustRoot: this.TrustRoot.PublicKey, ChannelUrl: W.ChannelUrl, Placements: this.Link }),
            new HiveReportHandler(this.Directory, this.Observations),
            ...this.HostChannel.Handlers(signer, this.TrustRoot.PublicKey, W.ChannelUrl),
        ])
        this.Channel = new WorldChannel(this.Exchange)
    }

    /** The customer level of a hosted hive's code. */
    public static readonly HostedLevel = CustomerHiveLevel.Hosted
}
