import { HiveLevel as CustomerHiveLevel } from '@pragmatic-tech-ai/pragmatic-customer-api-contract'
import {
    AgentExchangeLink, AgentExchangeRefusal, EnvelopeSigner, EnvelopeVerifier, InMemoryNonceLedger, Participant, SignedEnvelope, SigningKeyPair,
    type IAgentChannel, type INonceLedger,
} from '@pragmatic-tech-ai/pragmatic-hive-protocol'
import { FakeClock } from '@pragmatic-tech-ai/pragmatic-hive-protocol/testing'
import { MemoryRecordMap } from '@pragmatic-tech-ai/pragmatic-tenant-plane'
import { ClientRegistry } from '../../client-registry.js'
import { EnrolmentCodeIssuer } from '../../enrolment/enrolment-code-issuer.js'
import { EnrolmentAgentKind, EnrolmentCodeRegistry, type EnrolmentCodeRecord } from '../../enrolment/enrolment-code-record.js'
import { HiveObservationRegistry, type HiveObservationRecord } from '../../hive-observation-record.js'
import { HiveRegistry } from '../../hive-registry.js'
import { PlatformDirectory } from '../../platform-directory.js'
import type { ClientRecord, PlatformTenantRecord } from '../../platform-records.js'
import { TenantRegistry } from '../../tenant-registry.js'
import { HiveEnrolmentHandler } from '../hive-enrolment-handler.js'
import { HiveIdAllocator } from '../hive-id-allocator.js'
import { HiveReportHandler } from '../hive-report-handler.js'
import { AgentExchangeRefusedError, PlatformAgentExchange } from '../platform-agent-exchange.js'
import { PlatformKeyDirectory } from '../platform-key-directory.js'
import { HiveKeyRotationHandler } from '../hive-key-rotation-handler.js'
import { IntentOutbox } from '../../intents/intent-outbox.js'
import { IntentPublisher } from '../../intents/intent-publisher.js'
import { IntentStore, type IntentRecord } from '../../intents/intent-record.js'
import { IntentDecisionHandler } from '../../intents/intent-decision-handler.js'
import { HiveIntentPulls, PullHandler } from '../../intents/pull-handler.js'
import { SqlIntentSequences } from '../../intents/sql-intent-sequences.js'
import { PreviousKeyGrace } from '../previous-key-grace.js'
import { PreviousKeyGraceVerifier } from '../platform-agent-exchange.js'
import { PgSession } from '@pragmatic-tech-ai/pragmatic-realm-adapters'
import { SqlTestSessions } from '@pragmatic-tech-ai/pragmatic-realm-adapters/testing'

/** A refusal as the agent sees it through the channel: the code only. */
export class WorldRefusalError extends Error
{
    public constructor(public readonly Code: AgentExchangeRefusal)
    {
        super(Code)
        this.name = 'WorldRefusalError'
    }
}

/** An agent channel into the platform's exchange over wire text (strict codecs both ways); logs what was sent. */
export class WorldChannel implements IAgentChannel
{
    public readonly Sent: string[] = []

    public constructor(private readonly exchange: PlatformAgentExchange)
    {
    }

    public async Exchange(request: SignedEnvelope): Promise<SignedEnvelope | null>
    {
        return this.SendText(request.Encode())
    }

    public async SendText(text: string): Promise<SignedEnvelope | null>
    {
        this.Sent.push(text)
        try
        {
            const reply = await this.exchange.Exchange(SignedEnvelope.Decode(text, AgentExchangeLink.BodyLimit))
            return reply === null ? null : SignedEnvelope.Decode(reply.Encode())
        }
        catch (error)
        {
            throw new WorldRefusalError(AgentExchangeRefusedError.CodeOf(error))
        }
    }
}

/** Counts redemptions, so a test can prove a replay never reached the code. */
export class CountingCodes
{
    public Redeemed = 0

    public constructor(public readonly Issuer: EnrolmentCodeIssuer)
    {
    }

    public Redeem(code: string, expect: Parameters<EnrolmentCodeIssuer['Redeem']>[1]): Promise<EnrolmentCodeRecord>
    {
        this.Redeemed += 1
        return this.Issuer.Redeem(code, expect)
    }

    public Peek(code: string): Promise<EnrolmentCodeRecord | undefined>
    {
        return this.Issuer.Peek(code)
    }
}

/** The platform's side of the agent channel over in-memory stores, with a real code issuer and directory. */
export class HiveChannelWorld
{
    public static readonly ClientId = 'acme'
    public static readonly TenantA = 'acme'
    public static readonly TenantB = 'globex'
    public static readonly IssuedBy = 'https://login.example.test/realms/central\nsub-1'
    public static readonly ChannelUrl = 'https://agent.pragmatic.test'

    public readonly Clock = new FakeClock()
    public readonly TrustRoot = SigningKeyPair.Generate()
    public Directory!: PlatformDirectory
    public Observations!: HiveObservationRegistry
    public Codes!: CountingCodes
    public Exchange!: PlatformAgentExchange
    public Channel!: WorldChannel
    public Nonces!: INonceLedger
    public Intents!: IntentOutbox
    public Publisher!: IntentPublisher
    public Sequences!: SqlIntentSequences
    public IntentStore!: IntentStore

    public static async Create(nonces?: INonceLedger): Promise<HiveChannelWorld>
    {
        const world = new HiveChannelWorld()
        await world.Build(nonces)
        return world
    }

    public async IssueCode(tenant: string = HiveChannelWorld.TenantA, level: CustomerHiveLevel = CustomerHiveLevel.Enrolled, kind: EnrolmentAgentKind = EnrolmentAgentKind.Hive): Promise<string>
    {
        return (await this.Codes.Issuer.Issue({ ClientId: HiveChannelWorld.ClientId, TenantId: tenant, Level: level, AgentKind: kind, IssuedBy: HiveChannelWorld.IssuedBy })).Code
    }

    public LatestObservation(hiveId: string): HiveObservationRecord | undefined
    {
        return this.Observations.LatestRecord(hiveId)
    }

    private async Build(nonces: INonceLedger | undefined): Promise<void>
    {
        const W = HiveChannelWorld
        const clients = new ClientRegistry(new MemoryRecordMap<ClientRecord>())
        this.Directory = new PlatformDirectory(clients, new TenantRegistry(new MemoryRecordMap<PlatformTenantRecord>()), new HiveRegistry(new MemoryRecordMap()), { List: () => [] }, () => this.Clock.Now())
        await this.Directory.Load()
        await this.Directory.RecordClient({ id: W.ClientId, displayName: 'Acme' })
        await this.Directory.CreateTenant({ id: W.TenantA, clientId: W.ClientId, displayName: 'Acme' })
        await this.Directory.CreateTenant({ id: W.TenantB, clientId: W.ClientId, displayName: 'Globex' })
        const registry = new EnrolmentCodeRegistry(new MemoryRecordMap<EnrolmentCodeRecord>())
        await registry.Load()
        this.Codes = new CountingCodes(new EnrolmentCodeIssuer(registry, () => this.Clock.Now()))
        this.Observations = new HiveObservationRegistry(new MemoryRecordMap<HiveObservationRecord>())
        await this.Observations.Load()
        this.Nonces = nonces ?? new InMemoryNonceLedger(this.Clock)
        const verifier = new EnvelopeVerifier({ Self: Participant.Platform, Keys: new PlatformKeyDirectory(this.Directory), Nonces: this.Nonces, Clock: this.Clock })
        const signer = new EnvelopeSigner(this.TrustRoot, Participant.Platform, this.Clock)
        const ids = new HiveIdAllocator(id => this.Directory.GetHive(id) !== undefined)
        this.IntentStore = new IntentStore(new MemoryRecordMap<IntentRecord>())
        await this.IntentStore.Load()
        this.Intents = new IntentOutbox(this.IntentStore, () => this.Clock.Now())
        this.Sequences = await SqlIntentSequences.Open(new PgSession(SqlTestSessions.MemPool()))
        this.Publisher = new IntentPublisher(this.Intents, this.Directory, signer, this.Sequences)
        const grace = new PreviousKeyGrace(this.Directory, () => this.Clock.Now())
        this.Exchange = new PlatformAgentExchange(verifier, signer, [
            new HiveEnrolmentHandler({ Codes: this.Codes, Hives: this.Directory, Reports: this.Observations, Ids: ids, TrustRoot: this.TrustRoot.PublicKey, ChannelUrl: W.ChannelUrl }),
            new HiveReportHandler(this.Directory, this.Observations, this.Intents),
            new PullHandler([new HiveIntentPulls(this.Directory, this.Intents, this.Sequences)]),
            new IntentDecisionHandler(this.Directory, this.Intents),
            new HiveKeyRotationHandler(this.Directory),
        ], new PreviousKeyGraceVerifier(grace, new EnvelopeVerifier({ Self: Participant.Platform, Keys: grace, Nonces: this.Nonces, Clock: this.Clock })))
        this.Channel = new WorldChannel(this.Exchange)
    }
}
