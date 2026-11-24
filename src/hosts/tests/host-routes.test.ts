import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HostHealth } from '@pragmatic-tech-ai/pragmatic-hive-protocol'
import type { IEnvironmentService, IGraphService } from '@pragmatic-tech-ai/pragmatic-tenant-plane'
import { ControlPlaneHost } from '../../control-plane-host.js'
import { EnrolmentCodeIssuer } from '../../enrolment/enrolment-code-issuer.js'
import { EnrolmentAgentKind } from '../../enrolment/enrolment-code-record.js'
import { OperatorRole, type IOperatorIdentity, type OperatorPrincipal, type OperatorSummary } from '../../operator-identity.js'
import { HostSessions } from '../../tests/host-sessions.js'
import { HostRoutes, type HostRow } from '../host-routes.js'
import { HostWorld } from './host-world.js'

type Reply = { status: number; body: string; cacheControl: string | undefined }

class RouteOperator implements IOperatorIdentity
{
    public static readonly Token = 'valid-token'
    public static readonly Principal: OperatorPrincipal = { email: 'ops@pragmatic.test', principalId: 'p1', role: OperatorRole.Full }
    public Role: OperatorRole = OperatorRole.Full

    public async Verify(_email: string, _password: string): Promise<OperatorPrincipal | null>
    {
        return null
    }

    public async PrincipalOf(principalId: string): Promise<OperatorPrincipal | null>
    {
        return principalId === RouteOperator.Principal.principalId ? { ...RouteOperator.Principal, role: this.Role } : null
    }

    public async ListOperators(): Promise<readonly OperatorSummary[]>
    {
        return []
    }

    public async SetOperatorRole(): Promise<void>
    {
    }

    public async ChangeOwnPassword(): Promise<boolean>
    {
        return false
    }

    public async ResetOperatorPassword(): Promise<string>
    {
        return ''
    }

    public async SetOperatorDisabled(): Promise<void>
    {
    }

    public async RevokeOperatorSessions(): Promise<void>
    {
    }

    public async CreateOperator(): Promise<void>
    {
    }
}

class RouteCases
{
    public static Send(host: ControlPlaneHost, method: string, path: string): Promise<Reply>
    {
        const addr = host.Address()
        const headers = { 'content-type': 'application/json', cookie: 'cp_session=' + RouteOperator.Token }
        return new Promise((resolve, reject) =>
        {
            const req = request({ host: addr.address, port: addr.port, method, path, headers }, res =>
            {
                const chunks: Buffer[] = []
                res.on('data', c => chunks.push(c as Buffer))
                res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8'), cacheControl: res.headers['cache-control'] }))
            })
            req.on('error', reject)
            req.end(method === 'POST' ? '{}' : undefined)
        })
    }

    public static async With(world: HostWorld, operator: RouteOperator, work: (host: ControlPlaneHost) => Promise<void>): Promise<void>
    {
        const parent = mkdtempSync(join(tmpdir(), 'host-routes-'))
        const root = join(parent, 'static')
        mkdirSync(root)
        writeFileSync(join(root, 'index.html'), '<h1>portal</h1>')
        const sessions = await HostSessions.With(RouteOperator.Token, RouteOperator.Principal)
        const host = new ControlPlaneHost({
            Service: {} as IEnvironmentService, Graphs: {} as IGraphService, PortalRoot: root, Operator: operator, Sessions: sessions.Sessions,
            Directory: world.Directory, Deployments: {} as never, Provisioning: {} as never, Observations: {} as never,
            Hosts: new HostRoutes(world.Hosts, world.Placements, world.Codes, () => world.Clock.Now()),
        })
        await host.Listen(0, '127.0.0.1')
        try
        {
            await work(host)
        }
        finally
        {
            await host.Close()
            rmSync(parent, { recursive: true, force: true })
        }
    }
}

describe('HostRoutes', () =>
{
    const C = RouteCases
    it('POST /api/hosts/enrolment-code answers a host code once (operator.full), recorded as its hash only', async () =>
    {
        const world = await HostWorld.Create()
        await C.With(world, new RouteOperator(), async host =>
        {
            const reply = await C.Send(host, 'POST', HostRoutes.EnrolmentCodePath)
            assert.equal(reply.status, 201)
            assert.match(reply.cacheControl ?? '', /no-store/)
            const body = JSON.parse(reply.body) as { code: string; expiresAt: string }
            assert.match(body.code, EnrolmentCodeIssuer.CodePattern)
            const records = world.CodeRecords.List()
            assert.equal(records.length, 1)
            assert.equal(records[0]?.agentKind, EnrolmentAgentKind.Host)
            assert.equal(records[0]?.issuedBy, 'operator:' + RouteOperator.Principal.email)
            assert.ok(!JSON.stringify(records).includes(body.code), 'never stored')
            const listed = await C.Send(host, 'GET', HostRoutes.HostsPath)
            assert.ok(!listed.body.includes(body.code), 'never readable again')
        })
    })

    it('a read-only operator lists hosts but may not issue a code', async () =>
    {
        const world = await HostWorld.Create()
        const operator = new RouteOperator()
        operator.Role = OperatorRole.ReadOnly
        await C.With(world, operator, async host =>
        {
            assert.equal((await C.Send(host, 'POST', HostRoutes.EnrolmentCodePath)).status, 403)
            assert.equal((await C.Send(host, 'GET', HostRoutes.HostsPath)).status, 200)
            assert.equal(world.CodeRecords.List().length, 0)
        })
    })

    it('GET /api/hosts lists each host with capacity, free slots, last report and placements', async () =>
    {
        const world = await HostWorld.Create()
        const agent = await world.ReportingHost(4)
        const placement = await world.Request()
        await world.Scheduler.Tick()
        await C.With(world, new RouteOperator(), async host =>
        {
            const rows = JSON.parse((await C.Send(host, 'GET', HostRoutes.HostsPath)).body) as HostRow[]
            assert.equal(rows.length, 1)
            const row = rows[0] as HostRow
            assert.equal(row.id, agent.Self.Id)
            assert.equal(row.machine, HostWorld.Machine)
            assert.equal(row.fresh, true)
            assert.equal(row.health, HostHealth.Healthy)
            assert.equal(row.hiveSlots, 4)
            assert.equal(row.freeSlots, 3)
            assert.equal(row.capacity?.MemoryMiB, 32768)
            assert.deepEqual(row.placements.map(p => [p.id, p.tenantId, p.state, p.engineVersion]), [[placement.id, HostWorld.TenantA, 'scheduled', HostWorld.EngineVersion]])
            assert.ok(!JSON.stringify(row).includes('PRIVATE'))
        })
    })
})
