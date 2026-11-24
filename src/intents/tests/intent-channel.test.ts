import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { HiveLevel as CustomerHiveLevel } from '@pragmatic-tech-ai/pragmatic-customer-api-contract'
import {
    AgentExchangeRefusal, CreateEnvironment, DeleteEnvironment, EnvironmentPurpose, HiveLevel, HiveReport, IntentDecision, IntentDecisionKind, IntentFailure, IntentProgress,
    IntentStatus, MessageKind, Pull, RealmSubject, EnvelopeSigner, Participant, ParticipantRole, PullBatch, SigningKeyPair, VerifiedMessage,
} from '@pragmatic-tech-ai/pragmatic-hive-protocol'
import { FakeClock, FakeHiveAgent } from '@pragmatic-tech-ai/pragmatic-hive-protocol/testing'
import { AgentExchangeRefusedError } from '../../hive-channel/platform-agent-exchange.js'
import { PullHandler, type IPullSource } from '../pull-handler.js'
import { HiveBackend, InfraMode } from '@pragmatic-tech-ai/pragmatic-tenant-plane'
import { HiveChannelWorld, WorldRefusalError } from '../../hive-channel/tests/hive-channel-world.js'
import { IntentPublisher, IntentRefusal, IntentRefusedError } from '../intent-publisher.js'
import { DecisionRefusal } from '../intent-outbox.js'
import { SqlIntentSequences } from '../sql-intent-sequences.js'
import { PgSession } from '@pragmatic-tech-ai/pragmatic-realm-adapters'
import { SqlTestSessions } from '@pragmatic-tech-ai/pragmatic-realm-adapters/testing'

class IntentCases
{
    public static readonly Approver = RealmSubject.Of('acme', 'sub-7')
    public static readonly Day = 86_400_000
    public static readonly Operator = 'operator:ops@pragmatic.test'

    public static async Hive(world: HiveChannelWorld, level: HiveLevel = HiveLevel.Enrolled): Promise<FakeHiveAgent>
    {
        const agent = new FakeHiveAgent(world.Channel, world.Clock, world.TrustRoot.PublicKey)
        await agent.Enrol(await world.IssueCode(HiveChannelWorld.TenantA, level as string as CustomerHiveLevel), HiveChannelWorld.TenantA, level)
        return agent
    }

    public static Create(name: string): CreateEnvironment
    {
        return new CreateEnvironment(name, EnvironmentPurpose.Runtime, null)
    }

    public static Refused(code: IntentRefusal): (error: unknown) => boolean
    {
        return (error: unknown) => error instanceof IntentRefusedError && error.Code === code
    }

    public static Report(statuses: IntentStatus[]): HiveReport
    {
        return HiveReport.Create({ EngineVersion: '0.1.0', Components: [], Environments: [], Intents: statuses })
    }
}

describe('IntentPublisher', () =>
{
    it('publishing for a hosted or standalone hive is refused', async () =>
    {
        const world = await HiveChannelWorld.Create()
        await world.Directory.CreateHive({ id: 'hosted-one', tenantId: HiveChannelWorld.TenantA, displayName: 'h', cluster: { backend: HiveBackend.Local, mode: InfraMode.Attach }, registry: { mode: InfraMode.Attach }, level: CustomerHiveLevel.Hosted })
        await world.Directory.CreateHive({ id: 'standalone-one', tenantId: HiveChannelWorld.TenantB, displayName: 's', cluster: { backend: HiveBackend.Local, mode: InfraMode.Attach }, registry: { mode: InfraMode.Attach }, level: CustomerHiveLevel.Standalone })
        for (const id of ['hosted-one', 'standalone-one'])
        {
            await assert.rejects(world.Publisher.Publish(id, IntentCases.Create('prod'), IntentCases.Operator), IntentCases.Refused(IntentRefusal.HiveTakesNoIntents))
        }
        await assert.rejects(world.Publisher.Publish('nohive', IntentCases.Create('prod'), IntentCases.Operator), IntentCases.Refused(IntentRefusal.UnknownHive))
    })

    it('a push-installed hive and a left one take no intents', async () =>
    {
        const world = await HiveChannelWorld.Create()
        await world.Directory.CreateHive({ id: 'pushed-one', tenantId: HiveChannelWorld.TenantB, displayName: 'p', cluster: { backend: HiveBackend.Local, mode: InfraMode.Attach }, registry: { mode: InfraMode.Attach }, level: CustomerHiveLevel.Enrolled })
        const left = await IntentCases.Hive(world)
        await world.Directory.MarkHiveLeft(left.Self.Id)
        for (const id of ['pushed-one', left.Self.Id])
        {
            await assert.rejects(world.Publisher.Publish(id, IntentCases.Create('prod'), IntentCases.Operator), IntentCases.Refused(IntentRefusal.HiveTakesNoIntents))
        }
    })

    it('an intent has an in-prefixed id, the hive\'s level and next sequence, and a lifetime of 1 to 30 days', async () =>
    {
        const world = await HiveChannelWorld.Create()
        const hive = await IntentCases.Hive(world, HiveLevel.Delegated)
        const first = await world.Publisher.Publish(hive.Self.Id, IntentCases.Create('prod'), IntentCases.Operator)
        const second = await world.Publisher.Publish(hive.Self.Id, new DeleteEnvironment('old'), IntentCases.Operator, 30)
        assert.match(first.id, /^in[a-z2-7]{12}$/)
        assert.equal(first.level, HiveLevel.Delegated)
        assert.deepEqual([first.sequence, second.sequence], [1, 2])
        assert.equal(Date.parse(first.expiresAt) - Date.parse(first.issuedAt), 7 * IntentCases.Day)
        await assert.rejects(world.Publisher.Publish(hive.Self.Id, IntentCases.Create('x'), IntentCases.Operator, 31), IntentCases.Refused(IntentRefusal.Malformed))
        await assert.rejects(world.Publisher.Publish(hive.Self.Id, IntentCases.Create('x'), IntentCases.Operator, 0), IntentCases.Refused(IntentRefusal.Malformed))
    })
})

describe('IntentOutbox and pulls', () =>
{
    it('pull returns at most 100 in sequence order and a cursor, each verified by the hive under its trust root', async () =>
    {
        const world = await HiveChannelWorld.Create()
        const hive = await IntentCases.Hive(world)
        for (let i = 0; i < IntentPublisher.MaxOpen; i++)
        {
            await world.Publisher.Publish(hive.Self.Id, IntentCases.Create('env-' + i), IntentCases.Operator)
        }
        const first = await hive.PullIntents()
        assert.equal(first.length, IntentPublisher.MaxOpen)
        assert.deepEqual(first.slice(0, 2).map(item => (item.Body.Action as CreateEnvironment).Environment), ['env-0', 'env-1'])
        // The hive reports what it keeps: those are no longer served (the agent also skips ids it keeps).
        await hive.Report(IntentCases.Report(first.map(item => IntentStatus.Of(item.Body.IntentId, IntentProgress.AwaitingApproval))))
        assert.deepEqual(await hive.PullIntents(), [])
        const page = world.Intents.After(hive.Self.Id, 0, 20)
        assert.deepEqual([page.Items.length, page.Next], [20, page.Items.at(-1)?.sequence])
        // More open intents than a batch carries (records beyond the publisher's cap, as a store could hold): 100 at most.
        const template = world.Intents.ForHive(hive.Self.Id)[0]!
        for (let i = 0; i < 60; i++)
        {
            await world.IntentStore.Put({ ...template, id: 'in-synthetic-' + i, sequence: 1000 + i })
        }
        assert.equal(world.Intents.After(hive.Self.Id, 0, 500).Items.length, Pull.MaxItems)
    })

    it('an unknown cursor answers from the oldest open intent', async () =>
    {
        const world = await HiveChannelWorld.Create()
        const hive = await IntentCases.Hive(world)
        const applied = await world.Publisher.Publish(hive.Self.Id, IntentCases.Create('one'), IntentCases.Operator)
        const open = await world.Publisher.Publish(hive.Self.Id, IntentCases.Create('two'), IntentCases.Operator)
        await world.Publisher.Publish(hive.Self.Id, IntentCases.Create('three'), IntentCases.Operator)
        await world.Intents.RecordProgress(hive.Self.Id, [IntentStatus.Of(applied.id, IntentProgress.Applied)])
        const page = world.Intents.After(hive.Self.Id, 9_999)
        assert.deepEqual(page.Items.map(record => record.id)[0], open.id)
        assert.equal(page.Items.length, 2)
        assert.equal(page.Next, 9_999, 'the hive cursor is never moved back')
        await world.Intents.RecordProgress(hive.Self.Id, page.Items.map(record => IntentStatus.Of(record.id, IntentProgress.Applied)))
        assert.deepEqual(world.Intents.After(hive.Self.Id, 9_999).Items, [])
        assert.equal(world.Intents.After(hive.Self.Id, 9_999).Next, 9_999)
    })

    it('an expired intent is not served; reissue gives a new id and marks the old one superseded', async () =>
    {
        const world = await HiveChannelWorld.Create()
        const hive = await IntentCases.Hive(world)
        const old = await world.Publisher.Publish(hive.Self.Id, IntentCases.Create('prod'), IntentCases.Operator, 1)
        world.Clock.Advance(2 * IntentCases.Day)
        assert.deepEqual(world.Intents.After(hive.Self.Id, 0).Items, [])
        const fresh = await world.Publisher.Reissue(old.id, IntentCases.Operator)
        assert.notEqual(fresh.id, old.id)
        assert.equal(fresh.reissues, old.id)
        assert.equal(world.Intents.Get(old.id)?.supersededBy, fresh.id)
        assert.equal(Date.parse(fresh.expiresAt) - Date.parse(fresh.issuedAt), IntentCases.Day)
        const [pulled] = await hive.PullIntents()
        assert.equal(pulled?.Body.IntentId, fresh.id)
        await assert.rejects(world.Publisher.Reissue(old.id, IntentCases.Operator), IntentCases.Refused(IntentRefusal.NotReissuable))
        await assert.rejects(world.Publisher.Reissue('innothere', IntentCases.Operator), IntentCases.Refused(IntentRefusal.UnknownIntent))
    })

    it('a report\'s progress lands on the intent, with a failure code, and another hive\'s ids are ignored', async () =>
    {
        const world = await HiveChannelWorld.Create()
        const hive = await IntentCases.Hive(world)
        const other = await IntentCases.Hive(world)
        const mine = await world.Publisher.Publish(hive.Self.Id, IntentCases.Create('prod'), IntentCases.Operator)
        const theirs = await world.Publisher.Publish(other.Self.Id, IntentCases.Create('prod'), IntentCases.Operator)
        await hive.Report(IntentCases.Report([IntentStatus.FailedWith(mine.id, IntentFailure.EnvironmentExists), IntentStatus.Of(theirs.id, IntentProgress.Applied)]))
        assert.equal(world.Intents.Get(mine.id)?.progress, IntentProgress.Failed)
        assert.equal(world.Intents.Get(mine.id)?.failure, IntentFailure.EnvironmentExists)
        assert.equal(world.Intents.Get(theirs.id)?.progress, null)
        assert.deepEqual(world.LatestObservation(hive.Self.Id)?.intents, [{ intentId: mine.id, progress: IntentProgress.Failed, failure: IntentFailure.EnvironmentExists }, { intentId: theirs.id, progress: IntentProgress.Applied }])
    })

    it('a left hive\'s pull is refused hive-gone', async () =>
    {
        const world = await HiveChannelWorld.Create()
        const hive = await IntentCases.Hive(world)
        await world.Directory.MarkHiveLeft(hive.Self.Id)
        await assert.rejects(hive.PullIntents(), (error: unknown) => error instanceof WorldRefusalError && error.Code === AgentExchangeRefusal.HiveGone)
    })
})

describe('IntentDecisionHandler', () =>
{
    it('an approval is kept on the intent with its realm subject; a rejection is final', async () =>
    {
        const world = await HiveChannelWorld.Create()
        const hive = await IntentCases.Hive(world)
        const approve = await world.Publisher.Publish(hive.Self.Id, IntentCases.Create('prod'), IntentCases.Operator)
        const reject = await world.Publisher.Publish(hive.Self.Id, IntentCases.Create('test'), IntentCases.Operator)
        const [first, second] = await hive.PullIntents()
        await hive.Decide(first!, IntentDecisionKind.Approved, IntentCases.Approver)
        await hive.Decide(second!, IntentDecisionKind.Rejected, IntentCases.Approver)
        assert.deepEqual(world.Intents.Get(approve.id)?.decision?.subject, 'sub-7')
        assert.equal(world.Intents.Get(approve.id)?.decision?.decision, IntentDecisionKind.Approved)
        assert.equal(world.Intents.Get(reject.id)?.progress, IntentProgress.Rejected)
        await assert.rejects(world.Publisher.Reissue(reject.id, IntentCases.Operator), IntentCases.Refused(IntentRefusal.NotReissuable))
    })

    it('an approval for intent X does not apply to a reissued X with another digest', async () =>
    {
        const world = await HiveChannelWorld.Create()
        const hive = await IntentCases.Hive(world)
        const old = await world.Publisher.Publish(hive.Self.Id, IntentCases.Create('prod'), IntentCases.Operator, 1)
        const [pulled] = await hive.PullIntents()
        world.Clock.Advance(2 * IntentCases.Day)
        const fresh = await world.Publisher.Reissue(old.id, IntentCases.Operator)
        // The decision on the old envelope, moved onto the reissue's id: its digest is not the reissue's.
        const moved = IntentDecision.Parse({ ...IntentDecision.For(pulled!, IntentDecisionKind.Approved, IntentCases.Approver, world.Clock.Now()).ToJson(), IntentId: fresh.id })
        await assert.rejects(hive.Send(MessageKind.IntentDecision, moved), (error: unknown) => error instanceof WorldRefusalError && error.Code === AgentExchangeRefusal.NotVerified)
        assert.equal(world.Intents.Get(fresh.id)?.decision, null)
    })

    it('a decision on another hive\'s intent is refused', async () =>
    {
        const world = await HiveChannelWorld.Create()
        const hive = await IntentCases.Hive(world)
        const other = await IntentCases.Hive(world)
        await world.Publisher.Publish(hive.Self.Id, IntentCases.Create('prod'), IntentCases.Operator)
        const [pulled] = await hive.PullIntents()
        await assert.rejects(other.Send(MessageKind.IntentDecision, IntentDecision.For(pulled!, IntentDecisionKind.Approved, IntentCases.Approver, world.Clock.Now())),
            (error: unknown) => error instanceof WorldRefusalError && error.Code === AgentExchangeRefusal.NotVerified)
    })
})

describe('PullHandler dispatch by role', () =>
{
    it('a host\'s pull is refused unsupported-kind until a host source is plugged in, which then answers it', async () =>
    {
        const clock = new FakeClock()
        const host = Participant.Host('host-1')
        const pull = new VerifiedMessage(new EnvelopeSigner(SigningKeyPair.Generate(), host, clock).Sign(MessageKind.Pull, Participant.Platform, Pull.Create(0)), Pull.Create(0))
        await assert.rejects(new PullHandler([]).Handle(pull), (error: unknown) => error instanceof AgentExchangeRefusedError && error.Code === AgentExchangeRefusal.UnsupportedKind)
        const placements: IPullSource = { Role: ParticipantRole.Host, Answer: async () => PullBatch.Create([], 7) }
        const answer = await new PullHandler([placements]).Handle(pull)
        assert.equal(answer.Kind, MessageKind.PullBatch)
        assert.equal((answer.Body as PullBatch).Cursor, 7)
    })
})

describe('C3.4 review fixes', () =>
{
    it('only an expired or failed intent is reissued; an unexpired one the hive could still apply is not', async () =>
    {
        const world = await HiveChannelWorld.Create()
        const hive = await IntentCases.Hive(world)
        const fresh = await world.Publisher.Publish(hive.Self.Id, IntentCases.Create('a'), IntentCases.Operator)
        const awaiting = await world.Publisher.Publish(hive.Self.Id, IntentCases.Create('b'), IntentCases.Operator)
        const applying = await world.Publisher.Publish(hive.Self.Id, IntentCases.Create('c'), IntentCases.Operator)
        const failed = await world.Publisher.Publish(hive.Self.Id, IntentCases.Create('d'), IntentCases.Operator)
        await world.Intents.RecordProgress(hive.Self.Id, [
            IntentStatus.Of(awaiting.id, IntentProgress.AwaitingApproval), IntentStatus.Of(applying.id, IntentProgress.Applying), IntentStatus.FailedWith(failed.id, IntentFailure.ApplyFailed),
        ])
        for (const id of [fresh.id, awaiting.id, applying.id])
        {
            await assert.rejects(world.Publisher.Reissue(id, IntentCases.Operator), IntentCases.Refused(IntentRefusal.NotReissuable))
        }
        assert.ok((await world.Publisher.Reissue(failed.id, IntentCases.Operator)).id !== failed.id)
        await assert.rejects(world.Publisher.Reissue(failed.id, IntentCases.Operator), IntentCases.Refused(IntentRefusal.NotReissuable))
    })

    it('a decision on an expired, superseded or settled intent, or against the one kept, is refused; the same again is acknowledged', async () =>
    {
        const world = await HiveChannelWorld.Create()
        const hive = await IntentCases.Hive(world)
        const expiring = await world.Publisher.Publish(hive.Self.Id, IntentCases.Create('e'), IntentCases.Operator, 1)
        const settled = await world.Publisher.Publish(hive.Self.Id, IntentCases.Create('s'), IntentCases.Operator)
        const decided = await world.Publisher.Publish(hive.Self.Id, IntentCases.Create('d'), IntentCases.Operator)
        const pulled = new Map((await hive.PullIntents()).map(item => [item.Body.IntentId, item]))
        const refused = (error: unknown): boolean => error instanceof WorldRefusalError && error.Code === AgentExchangeRefusal.NotVerified
        const send = (id: string, kind: IntentDecisionKind): Promise<unknown> => hive.Send(MessageKind.IntentDecision, IntentDecision.For(pulled.get(id)!, kind, IntentCases.Approver, world.Clock.Now()))
        await world.Intents.RecordProgress(hive.Self.Id, [IntentStatus.Of(settled.id, IntentProgress.Applied)])
        await assert.rejects(send(settled.id, IntentDecisionKind.Approved), refused)
        await send(decided.id, IntentDecisionKind.Rejected)
        await send(decided.id, IntentDecisionKind.Rejected)
        await assert.rejects(send(decided.id, IntentDecisionKind.Approved), refused)
        assert.equal(world.Intents.Get(decided.id)?.decision?.decision, IntentDecisionKind.Rejected)
        // Past its expiry (the decision itself is fresh) no approval is kept, and once reissued neither.
        assert.equal(world.Intents.DecisionRefusalOf(world.Intents.Get(expiring.id)!, IntentDecision.For(pulled.get(expiring.id)!, IntentDecisionKind.Approved, IntentCases.Approver, world.Clock.Now())), undefined)
        world.Clock.Advance(IntentCases.Day + 60_000)
        assert.equal(world.Intents.DecisionRefusalOf(world.Intents.Get(expiring.id)!, IntentDecision.For(pulled.get(expiring.id)!, IntentDecisionKind.Approved, IntentCases.Approver, world.Clock.Now())), DecisionRefusal.Expired)
        const reissued = await world.Publisher.Reissue(expiring.id, IntentCases.Operator)
        assert.equal(world.Intents.Get(expiring.id)?.supersededBy, reissued.id)
        assert.equal(await world.Intents.RecordDecision(expiring.id, IntentDecision.For(pulled.get(expiring.id)!, IntentDecisionKind.Approved, IntentCases.Approver, world.Clock.Now())), DecisionRefusal.Superseded)
        assert.equal(world.Intents.Get(expiring.id)?.decision, null)
    })

    it('a report after a reissue never brings the superseded intent back', async () =>
    {
        const world = await HiveChannelWorld.Create()
        const hive = await IntentCases.Hive(world)
        const old = await world.Publisher.Publish(hive.Self.Id, IntentCases.Create('prod'), IntentCases.Operator, 1)
        await hive.PullIntents()
        world.Clock.Advance(2 * IntentCases.Day)
        const fresh = await world.Publisher.Reissue(old.id, IntentCases.Operator)
        await hive.Report(IntentCases.Report([IntentStatus.Of(old.id, IntentProgress.Expired)]))
        assert.equal(world.Intents.Get(old.id)?.supersededBy, fresh.id)
        assert.deepEqual(world.Intents.After(hive.Self.Id, 0).Items.map(record => record.id), [fresh.id])
    })

    it('publish past a stale cursor after restore: every intent published before the first pull is served', async () =>
    {
        const world = await HiveChannelWorld.Create()
        const hive = await IntentCases.Hive(world)
        // The snapshot a restore goes back to: two intents numbered, nothing pulled yet.
        const snapshot = await SqlIntentSequences.Open(new PgSession(SqlTestSessions.MemPool()))
        await snapshot.Next(hive.Self.Id, 0)
        await snapshot.Next(hive.Self.Id, 1)
        const kept: string[] = []
        for (let i = 0; i < 5; i++)
        {
            kept.push((await world.Publisher.Publish(hive.Self.Id, IntentCases.Create('e' + i), IntentCases.Operator)).id)
        }
        assert.equal((await hive.PullIntents()).length, 5)
        await world.Intents.RecordProgress(hive.Self.Id, kept.map(id => IntentStatus.Of(id, IntentProgress.Applied)))
        // The restore: the platform no longer knows intents 3-5, nor that it numbered them or that the hive pulled to 5.
        for (const id of kept.slice(2))
        {
            await world.IntentStore.Remove(id)
        }
        const publisher = new IntentPublisher(world.Intents, world.Directory, new EnvelopeSigner(world.TrustRoot, Participant.Platform, world.Clock), snapshot)
        const published: string[] = []
        for (let i = 0; i < 4; i++)
        {
            published.push((await publisher.Publish(hive.Self.Id, IntentCases.Create('after' + i), IntentCases.Operator)).id)
        }
        assert.ok(world.Intents.Get(published[0]!)!.sequence <= 5, 'numbered at or below the cursor the hive holds')
        assert.deepEqual((await hive.PullIntents()).map(item => item.Body.IntentId), published)
    })

    it('a backlog of unreported intents larger than a batch is paged through as the hive reports them', async () =>
    {
        const world = await HiveChannelWorld.Create()
        const hive = await IntentCases.Hive(world)
        const template = await world.Publisher.Publish(hive.Self.Id, IntentCases.Create('t'), IntentCases.Operator)
        for (let i = 0; i < 59; i++)
        {
            await world.IntentStore.Put({ ...template, id: 'in-backlog-' + i, sequence: 2 + i })
        }
        const first = world.Intents.After(hive.Self.Id, 9_999, 50)
        assert.equal(first.Items.length, 50)
        assert.equal(first.Next, 9_999)
        await world.Intents.RecordProgress(hive.Self.Id, first.Items.map(record => IntentStatus.Of(record.id, IntentProgress.AwaitingApproval)))
        const second = world.Intents.After(hive.Self.Id, 9_999, 50)
        assert.deepEqual(second.Items.map(record => record.sequence), Array.from({ length: 10 }, (_v, i) => 51 + i))
    })

    it('an approval sent after the intent expired is refused by the decision handler and not kept', async () =>
    {
        const world = await HiveChannelWorld.Create()
        const hive = await IntentCases.Hive(world)
        const intent = await world.Publisher.Publish(hive.Self.Id, IntentCases.Create('e'), IntentCases.Operator, 1)
        const [pulled] = await hive.PullIntents()
        world.Clock.Advance(IntentCases.Day + 60_000)
        await assert.rejects(hive.Send(MessageKind.IntentDecision, IntentDecision.For(pulled!, IntentDecisionKind.Approved, IntentCases.Approver, world.Clock.Now())),
            (error: unknown) => error instanceof WorldRefusalError && error.Code === AgentExchangeRefusal.NotVerified)
        assert.equal(world.Intents.Get(intent.id)?.decision, null)
    })

    it('two allocators over one table never hand out one number twice', async () =>
    {
        const session = new PgSession(SqlTestSessions.MemPool())
        const one = await SqlIntentSequences.Open(session)
        const two = await SqlIntentSequences.Open(session)
        const numbers = await Promise.all(Array.from({ length: 6 }, (_v, i) => (i % 2 === 0 ? one : two).Next('hvabcdefghij', 0)))
        assert.equal(new Set(numbers).size, 6)
        assert.deepEqual([...numbers].sort((a, b) => a - b), Array.from({ length: 6 }, (_v, i) => i + 1))
    })

    it('publishes for one hive run one at a time: the open-intent cap holds under concurrent requests', async () =>
    {
        const world = await HiveChannelWorld.Create()
        const hive = await IntentCases.Hive(world)
        const results = await Promise.allSettled(Array.from({ length: IntentPublisher.MaxOpen + 5 }, (_v, i) => world.Publisher.Publish(hive.Self.Id, IntentCases.Create('c' + i), IntentCases.Operator)))
        assert.equal(results.filter(result => result.status === 'fulfilled').length, IntentPublisher.MaxOpen)
        assert.equal(world.Intents.OpenForHive(hive.Self.Id).length, IntentPublisher.MaxOpen)
    })

    it('a hive pull keeps its cursor: numbers are allocated above it', async () =>
    {
        const world = await HiveChannelWorld.Create()
        const hive = await IntentCases.Hive(world)
        await hive.Send(MessageKind.Pull, Pull.Create(40))
        const next = await world.Publisher.Publish(hive.Self.Id, IntentCases.Create('x'), IntentCases.Operator)
        assert.equal(next.sequence, 41)
    })

    it('a hive keeps at most 50 open intents', async () =>
    {
        const world = await HiveChannelWorld.Create()
        const hive = await IntentCases.Hive(world)
        for (let i = 0; i < IntentPublisher.MaxOpen; i++)
        {
            await world.Publisher.Publish(hive.Self.Id, IntentCases.Create('e' + i), IntentCases.Operator)
        }
        await assert.rejects(world.Publisher.Publish(hive.Self.Id, IntentCases.Create('one-more'), IntentCases.Operator), IntentCases.Refused(IntentRefusal.TooManyOpen))
        assert.ok(world.Publisher.OpenCreateOf(hive.Self.Id, 'e7', EnvironmentPurpose.Runtime) !== undefined)
    })

    it('a hive not managed by intents may not pull them; settled intents are not served', async () =>
    {
        const world = await HiveChannelWorld.Create()
        const hosted = new FakeHiveAgent(world.Channel, world.Clock, world.TrustRoot.PublicKey)
        await hosted.Enrol(await world.IssueCode(HiveChannelWorld.TenantA, CustomerHiveLevel.Hosted), HiveChannelWorld.TenantA, HiveLevel.Hosted)
        await assert.rejects(hosted.PullIntents(), (error: unknown) => error instanceof WorldRefusalError && error.Code === AgentExchangeRefusal.UnsupportedKind)
        const hive = await IntentCases.Hive(world)
        const done = await world.Publisher.Publish(hive.Self.Id, IntentCases.Create('done'), IntentCases.Operator)
        const open = await world.Publisher.Publish(hive.Self.Id, IntentCases.Create('open'), IntentCases.Operator)
        await world.Intents.RecordProgress(hive.Self.Id, [IntentStatus.Of(done.id, IntentProgress.Applied)])
        assert.deepEqual(world.Intents.After(hive.Self.Id, 0).Items.map(record => record.id), [open.id])
    })
})

