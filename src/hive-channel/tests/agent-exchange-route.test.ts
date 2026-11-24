import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { InternalApiCredential } from '@pragmatic-tech-ai/pragmatic-component'
import { AgentExchangeLink, AgentExchangeRefusal, ComponentReport, ComponentState, EnvelopeSigner, HiveLevel, HiveReport, MessageKind, Participant, SignedEnvelope } from '@pragmatic-tech-ai/pragmatic-hive-protocol'
import { FakeHiveAgent } from '@pragmatic-tech-ai/pragmatic-hive-protocol/testing'
import type { IAgentChannelBackend, IDesktopDiscoveryBackend } from '@pragmatic-tech-ai/pragmatic-platform-link'
import { InternalApiRoutes } from '@pragmatic-tech-ai/pragmatic-platform-link'
import { InternalHost, InternalLink } from '../../internal/internal-host.js'
import { InternalSettings } from '../../internal/internal-settings.js'
import { HiveChannelWorld } from './hive-channel-world.js'

class RouteReply
{
    public constructor(public readonly Status: number, public readonly Text: string, public readonly ContentType: string | undefined)
    {
    }
}

/** The internal listener with the exchange mounted, over the in-memory platform world; HTTP to it as the edge sends. */
class RouteFixture
{
    public static readonly Loopback = '127.0.0.1'
    public static readonly Secret = 'r'.repeat(40)
    public static readonly Unused = { Handle: () => Promise.reject(new Error('unused')), Discover: () => Promise.reject(new Error('unused')) }

    public static Post(host: InternalHost, bearer: string | undefined, body: string, method: string = 'POST'): Promise<RouteReply>
    {
        const address = host.Address()
        const headers: Record<string, string> = { 'content-type': 'application/json' }
        if (bearer !== undefined)
        {
            headers.authorization = 'Bearer ' + bearer
        }
        return new Promise((resolve, reject) =>
        {
            const req = request({ host: address.address, port: address.port, method, path: InternalApiRoutes.AgentExchange, headers }, res =>
            {
                const chunks: Buffer[] = []
                res.on('data', chunk => chunks.push(chunk as Buffer))
                res.on('end', () => resolve(new RouteReply(res.statusCode ?? 0, Buffer.concat(chunks).toString('utf8'), res.headers['content-type'])))
            })
            req.on('error', reject)
            req.end(body)
        })
    }
}

describe('AgentExchangeRoute', () =>
{
    const F = RouteFixture
    let parent = ''
    let host: InternalHost
    let world: HiveChannelWorld
    let bearer = ''

    before(async () =>
    {
        parent = mkdtempSync(join(tmpdir(), 'agent-exchange-route-'))
        const secret = join(parent, 'internal')
        writeFileSync(secret, F.Secret)
        bearer = InternalApiCredential.FromFile(secret).Bearer()
        world = await HiveChannelWorld.Create()
        host = new InternalHost(new InternalSettings(0, F.Loopback, secret), {
            Agent: F.Unused as unknown as IAgentChannelBackend, Discovery: F.Unused as unknown as IDesktopDiscoveryBackend, Exchange: world.Exchange,
        })
        await host.Listen()
    })

    after(async () =>
    {
        await host.Close()
        rmSync(parent, { recursive: true, force: true })
    })

    it('mounts the exchange as its own link', () =>
    {
        assert.ok(host.Links.includes(InternalLink.AgentExchange))
    })

    it('needs the internal bearer', async () =>
    {
        for (const wrong of [undefined, 'wrong'])
        {
            assert.equal((await F.Post(host, wrong, '{}')).Status, 401)
        }
    })

    it('answers an enrolment 200 with the signed envelope, a report 204, a replay its refusal code', async () =>
    {
        const http = { Exchange: async (envelope: SignedEnvelope): Promise<SignedEnvelope | null> =>
        {
            const reply = await F.Post(host, bearer, envelope.Encode())
            if (reply.Status === AgentExchangeLink.StatusAcknowledged)
            {
                return null
            }
            assert.equal(reply.Status, AgentExchangeLink.StatusAnswered, reply.Text)
            assert.match(reply.ContentType ?? '', /application\/json/)
            return SignedEnvelope.Decode(reply.Text)
        } }
        const agent = new FakeHiveAgent(http, world.Clock, world.TrustRoot.PublicKey)
        const enrolled = await agent.Enrol(await world.IssueCode(), HiveChannelWorld.TenantA, HiveLevel.Enrolled)
        const report = HiveReport.Create({ EngineVersion: '0.1.7', Components: [new ComponentReport('pragmatic-hive-agent', ComponentState.Ready, '0.1.7')], Environments: [], Intents: [] })
        await agent.Report(report)
        assert.ok(world.LatestObservation(enrolled.HiveId) !== undefined)
        const signed = new EnvelopeSigner(agent.Key, agent.Self, world.Clock).Sign(MessageKind.HiveReport, Participant.Platform, report)
        assert.equal((await F.Post(host, bearer, signed.Encode())).Status, 204)
        const again = await F.Post(host, bearer, signed.Encode())
        assert.equal(again.Status, AgentExchangeLink.StatusOf(AgentExchangeRefusal.Replayed))
        assert.deepEqual(JSON.parse(again.Text), AgentExchangeLink.RefusalBody(AgentExchangeRefusal.Replayed))
    })

    it('over 1 MiB is 413 and garbage is malformed, codes only', async () =>
    {
        const big = await F.Post(host, bearer, 'x'.repeat(AgentExchangeLink.BodyLimit + 1))
        // Refused by its declared length before the route runs (the host's own 413), so nothing is read or verified.
        assert.equal(big.Status, AgentExchangeLink.StatusOf(AgentExchangeRefusal.TooLarge))
        const junk = await F.Post(host, bearer, 'not json at all')
        assert.equal(junk.Status, 400)
        assert.deepEqual(JSON.parse(junk.Text), AgentExchangeLink.RefusalBody(AgentExchangeRefusal.Malformed))
    })
})
