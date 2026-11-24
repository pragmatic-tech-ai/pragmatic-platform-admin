import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { K8sManifestBuilder } from '@pragmatic-tech-ai/pragmatic-tenant-plane'
import { AppliedConfigurationKeys } from '@pragmatic-tech-ai/pragmatic-configuration-runtime'
import { AgentConfigurationHold } from '../agent-configuration-hold.js'
import { ConsoleBootstrapSplit } from '../console-bootstrap-split.js'
import { ConsoleReleaseDescriptors } from '../console-release-descriptors.js'
import { ReleaseApp } from '@pragmatic-tech-ai/pragmatic-release-toolkit'
import { ConsoleInstallState } from '../tenant-console-installer.js'
import { ConsoleInstallFixture } from './console-install-fakes.js'
import { AgentEnvOwnership } from './agent-env-ownership.js'

type Obj = Record<string, any>

/** A hive agent as the pre-0.18 bundle rendered it (the live staff hive): no component labels, no configuration mounts. */
class OldAgent
{
    public static readonly Image = 'ghcr.io/pragmatic-tech-ai/pragmatic-hive-agent@sha256:' + 'c'.repeat(64)
    public static readonly Hash = `sha256:${'7'.repeat(64)}`
    public static readonly Name = K8sManifestBuilder.HiveAgentNameOf('h1')

    public static Live(): Obj
    {
        return {
            apiVersion: 'apps/v1', kind: 'Deployment',
            metadata: {
                name: OldAgent.Name, namespace: 'pragmatic-system', labels: { 'pragmatic/hive': 'h1' }, resourceVersion: '81', uid: 'u-1', generation: 4,
                annotations: { 'deployment.kubernetes.io/revision': '4', 'kubectl.kubernetes.io/last-applied-configuration': '{}' },
                managedFields: [{ manager: 'kubectl-client-side-apply' }],
            },
            spec: {
                replicas: 1, selector: { matchLabels: { 'pragmatic/app': OldAgent.Name } },
                template: {
                    metadata: { labels: { 'pragmatic/app': OldAgent.Name }, annotations: { [AppliedConfigurationKeys.HashAnnotation]: OldAgent.Hash } },
                    spec: {
                        serviceAccountName: OldAgent.Name,
                        containers: [{ name: 'agent', image: OldAgent.Image, env: [{ name: 'PRAGMATIC_AGENT_TOKEN', valueFrom: { secretKeyRef: { name: 'agent-token', key: 'token' } } }] }],
                    },
                },
            },
            status: { availableReplicas: 1 },
        }
    }

    public static Held(manifest: string): Obj
    {
        return (JSON.parse(manifest) as { items: Obj[] }).items[0]
    }
}

describe('AgentConfigurationHold (I2: the agent of an existing hive becomes a configuration target)', () =>
{
    it('attaches the labels, mounts and surge roll to the running agent and holds its image, environment and template annotations', () =>
    {
        const held = OldAgent.Held(AgentConfigurationHold.Of(JSON.stringify(OldAgent.Live()))!)
        const container = held.spec.template.spec.containers[0]
        assert.equal(container.image, OldAgent.Image, 'the image is held')
        assert.deepEqual(container.env, OldAgent.Live().spec.template.spec.containers[0].env, 'the environment is the image own')
        assert.equal(container.readinessProbe, undefined, 'no probe an older image could never pass')
        assert.equal(held.spec.template.metadata.annotations[AppliedConfigurationKeys.HashAnnotation], OldAgent.Hash)
        for (const labels of [held.metadata.labels, held.spec.template.metadata.labels])
        {
            assert.equal(labels['component.pragmatic-tech.ai/pragmatic-hive-agent'], 'agent')
            assert.equal(labels['app.kubernetes.io/managed-by'], 'pragmatic-tenant-admin')
        }
        assert.equal(held.metadata.labels['pragmatic/hive'], 'h1')
        assert.deepEqual(held.spec.selector, OldAgent.Live().spec.selector, 'the selector is never touched')
        assert.ok(container.volumeMounts.some((m: Obj) => m.mountPath === '/etc/pragmatic/configuration'))
        assert.ok(held.spec.template.spec.volumes.some((v: Obj) => v.configMap?.name === 'pragmatic-config-pragmatic-hive-agent'))
        assert.deepEqual(held.spec.strategy, { type: 'RollingUpdate', rollingUpdate: { maxUnavailable: 0, maxSurge: 1 } })
        assert.equal(held.spec.minReadySeconds, 10)
        assert.equal(held.status, undefined)
        for (const key of ['resourceVersion', 'uid', 'generation', 'managedFields']) assert.equal(held.metadata[key], undefined, key)
        assert.deepEqual(Object.keys(held.metadata.annotations), [])
        const again = OldAgent.Held(AgentConfigurationHold.Of(JSON.stringify({ ...OldAgent.Live(), spec: held.spec, metadata: { ...OldAgent.Live().metadata, labels: held.metadata.labels } }))!)
        assert.deepEqual(again.spec, held.spec, 'a second install attaches nothing twice')
    })

    it('holds nothing without a running agent, or one with no agent container', () =>
    {
        assert.equal(AgentConfigurationHold.Of(undefined), undefined)
        const other = OldAgent.Live()
        other.spec.template.spec.containers[0].name = 'other'
        assert.equal(AgentConfigurationHold.Of(JSON.stringify(other)), undefined)
    })

    it('renders the agent empty ConfigMap and Secret, with no data', () =>
    {
        const items = AgentConfigurationHold.ConfigurationObjects('h1').map(m => JSON.parse(m) as Obj)
        assert.deepEqual(items.map(i => [i.kind, i.metadata.namespace, i.metadata.name]), [
            ['ConfigMap', 'pragmatic-system', 'pragmatic-config-pragmatic-hive-agent'], ['Secret', 'pragmatic-system', 'pragmatic-secrets-pragmatic-hive-agent'],
        ])
        assert.ok(items.every(i => i.data === undefined && i.stringData === undefined))
    })
})

describe('TenantConsoleInstaller over an existing hive agent', () =>
{
    let fx: ConsoleInstallFixture | undefined
    afterEach(() => fx?.Dispose())

    it('an install over an old-render agent leaves its image unchanged and the labels, mounts and empty objects present; never its token or RBAC', async () =>
    {
        fx = await ConsoleInstallFixture.Create()
        fx.Kubectl.Put('pragmatic-system', 'deployment/' + OldAgent.Name, OldAgent.Live())
        fx.Installer.Start('h1')
        assert.equal((await fx.Installer.WhenSettled('h1'))?.state, ConsoleInstallState.Deployed)
        const held = fx.Kubectl.ServerApplied.map(m => JSON.parse(m) as { items?: Obj[] }).flatMap(l => l.items ?? []).filter(i => i.kind === 'Deployment' && i.metadata.name === OldAgent.Name)
        assert.equal(held.length, 2, 'the agent is held server-side once, then its roll goes server-side too (row 4)')
        assert.equal(held[0].spec.template.spec.containers[0].image, OldAgent.Image)
        assert.equal(held[0].metadata.labels['component.pragmatic-tech.ai/pragmatic-hive-agent'], 'agent')
        const created = fx.Kubectl.Created.map(m => JSON.parse(m) as Obj).map(i => i.metadata.name)
        assert.ok(created.includes('pragmatic-config-pragmatic-hive-agent') && created.includes('pragmatic-secrets-pragmatic-hive-agent'))
        // Then, after the console restarted, the agent moves onto the release's agent image: applied server-side under the
        // hold's manager (which owns the token variable the hold kept, so it goes) and then client-side, its configuration
        // hash kept, awaited before the IdP.
        const rolls = fx.Kubectl.Applied.map(m => JSON.parse(m) as { items?: Obj[] }).flatMap(l => l.items ?? []).filter(i => i.kind === 'Deployment' && i.metadata?.name === OldAgent.Name)
        assert.equal(rolls.length, 1)
        const container = rolls[0].spec.template.spec.containers[0]
        assert.notEqual(container.image, OldAgent.Image, 'the release image')
        assert.equal(container.env.find((e: Obj) => e.name === 'PRAGMATIC_AGENT_TOKEN'), undefined)
        assert.ok(container.env.some((e: Obj) => e.name === 'PRAGMATIC_AGENT_TOKEN_FILE'))
        assert.ok(container.readinessProbe !== undefined)
        assert.equal(rolls[0].spec.template.metadata.annotations[AppliedConfigurationKeys.HashAnnotation], OldAgent.Hash, 'the applied configuration stays')
        const verbs = fx.Kubectl.Calls.map(c => c.join(' '))
        const restarted = verbs.indexOf('RolloutRestart pragmatic-system ' + K8sManifestBuilder.TenantAdminNameOf('acme'))
        const agentWait = verbs.indexOf('RolloutStatus pragmatic-system ' + OldAgent.Name)
        const idpWait = verbs.lastIndexOf('RolloutStatus ' + K8sManifestBuilder.IdpNameOf('acme') + ' ' + K8sManifestBuilder.IdpNameOf('acme'))
        assert.ok(restarted < agentWait && agentWait < idpWait, 'console, then agent, then IdP')
        const all = [...fx.Kubectl.Applied, ...fx.Kubectl.ServerApplied].map(m => JSON.parse(m) as { items?: Obj[] }).flatMap(l => l.items ?? [])
        const agentRbac = [K8sManifestBuilder.HiveAgentNameOf('h1'), K8sManifestBuilder.AgentTokenSecretNameOf('h1')]
        assert.ok(!all.some(i => (i.kind === 'ClusterRole' || i.kind === 'ClusterRoleBinding' || i.kind === 'ServiceAccount' || i.kind === 'Secret') && agentRbac.includes(i.metadata.name)))
        assert.equal(fx.Registrar.Calls, 0)
        // Held before the console restarts, so the restarted console finds the agent as a target.
        const holdAt = fx.Kubectl.Calls.findIndex(c => c[0] === 'ApplyServerSide')
        const restartAt = fx.Kubectl.Calls.findIndex(c => c[0] === 'RolloutRestart')
        assert.ok(holdAt >= 0 && holdAt < restartAt)
    })
})

describe('the IdP roll drops a configuration volume nothing mounts (M3)', () =>
{
    let fx: ConsoleInstallFixture | undefined
    afterEach(() => fx?.Dispose())

    const idp = K8sManifestBuilder.IdpNameOf('acme')
    const live = (stale: boolean): Obj => ({
        apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: idp, namespace: idp },
        spec: {
            replicas: 1,
            template: {
                metadata: { annotations: {} },
                spec: {
                    containers: [{ name: 'idp', image: 'ghcr.io/x/pragmatic-tenant-idp@sha256:' + '1'.repeat(64), volumeMounts: [{ name: 'cfg-tenant-idp', mountPath: '/etc/pragmatic/configuration' }] }],
                    volumes: [
                        { name: 'cfg-tenant-idp', configMap: { name: 'pragmatic-config-pragmatic-tenant-idp', optional: true } },
                        ...(stale ? [{ name: 'configuration', configMap: { name: 'pragmatic-config-pragmatic-tenant-idp' } }] : []),
                    ],
                },
            },
        },
        status: { observedGeneration: 1, replicas: 1, updatedReplicas: 1, availableReplicas: 1 },
    })

    it('names the volumes of a pragmatic-config ConfigMap that no container mounts', () =>
    {
        assert.deepEqual(ConsoleBootstrapSplit.StaleConfigurationVolumes(JSON.stringify(live(true))), ['configuration'])
        assert.deepEqual(ConsoleBootstrapSplit.StaleConfigurationVolumes(JSON.stringify(live(false))), [])
        assert.deepEqual(ConsoleBootstrapSplit.StaleConfigurationVolumes(undefined), [])
    })

    it('with one, the roll is applied server-side first (dropping it) then client-side, the same template', async () =>
    {
        fx = await ConsoleInstallFixture.Create()
        fx.Kubectl.Put(idp, 'deployment/' + idp, live(true))
        fx.Installer.Start('h1')
        assert.equal((await fx.Installer.WhenSettled('h1'))?.state, ConsoleInstallState.Deployed)
        const restartAt = fx.Kubectl.Calls.findIndex(c => c[0] === 'RolloutRestart')
        const after = fx.Kubectl.Calls.slice(restartAt).map(c => c[0]).filter(v => v === 'ApplyServerSide' || v === 'Apply')
        assert.deepEqual(after, ['ApplyServerSide', 'Apply'])
        const rolled = fx.Kubectl.ServerApplied[fx.Kubectl.ServerApplied.length - 1]
        assert.equal(rolled, fx.Kubectl.Applied[fx.Kubectl.Applied.length - 1], 'the same template both ways')
        const template = (JSON.parse(rolled) as { items: Obj[] }).items[0].spec.template
        assert.ok(!template.spec.volumes.some((v: Obj) => v.name === 'configuration'))
    })

    it('without one, the roll stays one client-side apply', async () =>
    {
        fx = await ConsoleInstallFixture.Create()
        fx.Kubectl.Put(idp, 'deployment/' + idp, live(false))
        fx.Installer.Start('h1')
        assert.equal((await fx.Installer.WhenSettled('h1'))?.state, ConsoleInstallState.Deployed)
        const restartAt = fx.Kubectl.Calls.findIndex(c => c[0] === 'RolloutRestart')
        assert.deepEqual(fx.Kubectl.Calls.slice(restartAt).map(c => c[0]).filter(v => v === 'ApplyServerSide' || v === 'Apply'), ['Apply'])
    })
})

describe('the agent roll that does not finish', () =>
{
    let fx: ConsoleInstallFixture | undefined
    afterEach(() => fx?.Dispose())

    it('stops the install before the IdP, saying the old agent keeps serving', async () =>
    {
        fx = await ConsoleInstallFixture.Create()
        fx.Kubectl.Put('pragmatic-system', 'deployment/' + OldAgent.Name, OldAgent.Live())
        fx.Kubectl.RolloutStatusFailures.set('pragmatic-system', [false, true])
        fx.Installer.Start('h1')
        const status = await fx.Installer.WhenSettled('h1')
        assert.equal(status?.state, ConsoleInstallState.Failed)
        assert.match(status?.error ?? '', /hive agent did not finish rolling onto this release; its previous pod keeps serving/)
        const idp = K8sManifestBuilder.IdpNameOf('acme')
        assert.ok(!fx.Kubectl.Calls.some(c => c[0] === 'RolloutStatus' && c[1] === idp), 'the IdP was not touched')
    })

    it('renders nothing to roll without a running agent', () =>
    {
        assert.equal(AgentConfigurationHold.ReleaseRoll(undefined, 'h1', 'http://channel', 'agent:1'), undefined)
    })
})

describe('ConsoleReleaseDescriptors.SameRelease (the agent rolls with the console only from the release it delivers)', () =>
{
    it('answers whether an app image comes from the release of the console', () =>
    {
        const releases = new Map<string, string>([['pragmatic-tenant-admin', '0.1.0-early.12'], ['pragmatic-hive-agent', '0.1.0-early.11']])
        const descriptors = new ConsoleReleaseDescriptors({ ReleaseOf: (app: string) => releases.get(app) } as never, { DescriptorsOf: async () => undefined } as never)
        assert.equal(descriptors.SameRelease(ReleaseApp.HiveAgent), false)
        releases.set('pragmatic-hive-agent', '0.1.0-early.12')
        assert.equal(descriptors.SameRelease(ReleaseApp.HiveAgent), true)
    })
})

describe('a console install leaves no plain agent token variable on an existing agent (live proof row 4)', () =>
{
    let fx: ConsoleInstallFixture | undefined
    afterEach(() => fx?.Dispose())

    const Token = 'PRAGMATIC_AGENT_TOKEN'
    const TokenFile = 'PRAGMATIC_AGENT_TOKEN_FILE'
    const Wiring = ['PRAGMATIC_AGENT_HIVE_ID', 'PRAGMATIC_AGENT_REGISTRY_URL']

    const Running = (env: readonly string[]): Obj =>
    {
        const live = OldAgent.Live()
        live.spec.template.spec.containers[0].env = env.map(name => name === Token
            ? { name, valueFrom: { secretKeyRef: { name: K8sManifestBuilder.AgentTokenSecretNameOf('h1'), key: 'token' } } }
            : { name, value: 'x' })
        return live
    }

    it('an agent the first bundle rendered (the token variable recorded by kubectl\'s client-side apply) ends with the token as a file only', async () =>
    {
        fx = await ConsoleInstallFixture.Create()
        fx.Kubectl.Put('pragmatic-system', 'deployment/' + OldAgent.Name, Running([...Wiring, Token]))
        fx.Installer.Start('h1')
        assert.equal((await fx.Installer.WhenSettled('h1'))?.state, ConsoleInstallState.Deployed)
        const env = new AgentEnvOwnership({ [AgentEnvOwnership.ClientManager]: [...Wiring, Token] }, [...Wiring, Token]).Replay(fx.Kubectl, OldAgent.Name)
        assert.deepEqual(env.Names, [...Wiring, TokenFile].sort())
    })

    it('the agent the early.13 install left (the token variable owned by the hold\'s server-side manager) loses it on the next install', async () =>
    {
        fx = await ConsoleInstallFixture.Create()
        fx.Kubectl.Put('pragmatic-system', 'deployment/' + OldAgent.Name, Running([...Wiring, TokenFile, Token]))
        fx.Installer.Start('h1')
        assert.equal((await fx.Installer.WhenSettled('h1'))?.state, ConsoleInstallState.Deployed)
        const env = new AgentEnvOwnership({ [AgentEnvOwnership.ServerManager]: [...Wiring, Token], [AgentEnvOwnership.ClientManager]: [TokenFile] }, [...Wiring, TokenFile])
            .Replay(fx.Kubectl, OldAgent.Name)
        assert.deepEqual(env.Names, [...Wiring, TokenFile].sort())
    })

    it('a refused agent roll apply stops the install before the IdP with its own sentence, the kubectl text attached (review M8)', async () =>
    {
        const rollAt = async (): Promise<number> =>
        {
            const probe = await ConsoleInstallFixture.Create()
            try
            {
                probe.Kubectl.Put('pragmatic-system', 'deployment/' + OldAgent.Name, Running([...Wiring, Token]))
                probe.Installer.Start('h1')
                await probe.Installer.WhenSettled('h1')
                return probe.Kubectl.Applied.findIndex(m => ((JSON.parse(m) as { items?: Obj[] }).items ?? []).some(i => i.kind === 'Deployment' && i.metadata?.name === OldAgent.Name))
            }
            finally
            {
                probe.Dispose()
            }
        }
        const at = await rollAt()
        assert.ok(at >= 0)
        fx = await ConsoleInstallFixture.Create()
        fx.Kubectl.Put('pragmatic-system', 'deployment/' + OldAgent.Name, Running([...Wiring, Token]))
        fx.Kubectl.ApplyFailures.add(at)
        fx.Installer.Start('h1')
        const status = await fx.Installer.WhenSettled('h1')
        assert.equal(status?.state, ConsoleInstallState.Failed)
        assert.match(status?.error ?? '', /^The hive agent could not be moved onto this release: the cluster refused its Deployment/)
        assert.match(status?.error ?? '', /apply refused/)
        const idp = K8sManifestBuilder.IdpNameOf('acme')
        assert.ok(!fx.Kubectl.Calls.some(c => c[0] === 'RolloutStatus' && c[1] === idp), 'the IdP was not touched')
    })

    it('the roll is applied server-side, under the hold\'s manager, then client-side: the same template, after the hold', async () =>
    {
        fx = await ConsoleInstallFixture.Create()
        fx.Kubectl.Put('pragmatic-system', 'deployment/' + OldAgent.Name, Running([...Wiring, Token]))
        fx.Installer.Start('h1')
        assert.equal((await fx.Installer.WhenSettled('h1'))?.state, ConsoleInstallState.Deployed)
        const agentApplies = (list: string[]) => list.filter(m => ((JSON.parse(m) as { items?: Obj[] }).items ?? []).some(i => i.kind === 'Deployment' && i.metadata?.name === OldAgent.Name))
        const server = agentApplies(fx.Kubectl.ServerApplied)
        assert.equal(server.length, 2, 'the hold, then the roll')
        assert.deepEqual(agentApplies(fx.Kubectl.Applied), [server[1]], 'the roll both ways')
        const serverCalls = fx.Kubectl.Calls.map((c, i) => c[0] === 'ApplyServerSide' ? i : -1).filter(i => i >= 0)
        const rollServerAt = serverCalls[fx.Kubectl.ServerApplied.indexOf(server[1]!)]!
        const agentWait = fx.Kubectl.Calls.findIndex(c => c.join(' ') === 'RolloutStatus pragmatic-system ' + OldAgent.Name)
        assert.ok(rollServerAt >= 0 && rollServerAt < agentWait)
    })
})
