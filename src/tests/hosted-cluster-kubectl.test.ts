import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { HiveBackend, InfraMode, KubectlHiveOrchestrator, type HiveRecord } from '@pragmatic-tech-ai/pragmatic-tenant-plane'
import { KubectlCli, type IExecFile, type IProcessSpawner, type ISpawnedProcess } from '@pragmatic-tech-ai/pragmatic-kube'
import { ClusterCredentialHandover } from '@pragmatic-tech-ai/pragmatic-hive-protocol'
import { CredentialKubeconfigExec, HostedClusterKubectl, type IClusterCredentialSource } from '../hosted-cluster-kubectl.js'
import { HostedHiveOrchestratorFactory } from '../hosted-hive-orchestrator-factory.js'
import { RegistryRefImageDigest } from '../image-digest.js'

/** A credential store a test sets by reference. */
class FakeCredentials implements IClusterCredentialSource
{
    public readonly Values = new Map<string, Buffer>()

    public Get(ref: string): Promise<Buffer | undefined>
    {
        const value = this.Values.get(ref)
        return Promise.resolve(value === undefined ? undefined : Buffer.from(value))
    }
}

/** Records each kubectl run: its args and the kubeconfig content it saw; fails when told to. */
class RecordingExec implements IExecFile
{
    public readonly Runs: Array<{ Args: readonly string[]; Kubeconfig: string; Mode: number }> = []
    public Fail = false

    public Run(_file: string, args: readonly string[], _stdin?: string): Promise<{ stdout: string; stderr: string }>
    {
        const path = args[1] as string
        this.Runs.push({ Args: args, Kubeconfig: readFileSync(path, 'utf8'), Mode: statSync(path).mode & 0o777 })
        return this.Fail ? Promise.reject(Object.assign(new Error('kubectl failed'), { stderr: 'boom' })) : Promise.resolve({ stdout: '{}', stderr: '' })
    }
}

/** A port-forward whose process the test ends; prints the forwarding line at once. */
class FakeSpawner implements IProcessSpawner
{
    public Args: readonly string[] = []
    public Kubeconfig = ''
    private exit: (() => void) | undefined

    public Spawn(_file: string, args: readonly string[]): ISpawnedProcess
    {
        this.Args = args
        this.Kubeconfig = readFileSync(args[1] as string, 'utf8')
        const stdout = new PassThrough()
        setImmediate(() => stdout.write('Forwarding from 127.0.0.1:41234 -> 7100\n'))
        return { Stdout: stdout, Kill: () => this.exit?.(), OnExit: cb => { this.exit = cb } }
    }

    public End(): void
    {
        this.exit?.()
    }
}

class KubectlCases
{
    public static readonly Placement = 'pl-abcdefghijklmnop'
    public static readonly Ref = ClusterCredentialHandover.ReferenceFor(KubectlCases.Placement)
    public static readonly First = 'apiVersion: v1\nkind: Config\n# rotation 1\n'
    public static readonly Second = 'apiVersion: v1\nkind: Config\n# rotation 2\n'

    public static Root(): string
    {
        return mkdtempSync(join(tmpdir(), 'hosted-kubectl-'))
    }

    public static Hive(configRef: string): HiveRecord
    {
        return { id: 'hvaaaaaaaaaa', tenantId: 'acme', displayName: 'hive', cluster: { backend: HiveBackend.Local, mode: InfraMode.Attach, configRef }, registry: { mode: InfraMode.Attach }, createdAt: '2026-11-24T00:00:00.000Z' }
    }
}

describe('HostedClusterKubectl', () =>
{
    const C = KubectlCases
    it('a hosted hive\'s orchestrator uses its own credential; a legacy record keeps its context', () =>
    {
        const factory = new HostedHiveOrchestratorFactory(undefined, join(tmpdir(), 'hosted-kubectl-data'), new RegistryRefImageDigest(), undefined, new FakeCredentials())
        const placed = factory.For(C.Hive(C.Ref))
        assert.ok(placed instanceof KubectlHiveOrchestrator)
        assert.ok(placed.Kubectl instanceof HostedClusterKubectl)
        const legacy = factory.For(C.Hive('pragmatic-hive'))
        assert.ok(legacy.Kubectl instanceof KubectlCli && !(legacy.Kubectl instanceof HostedClusterKubectl))
        assert.equal((legacy.Kubectl as KubectlCli).Context, 'pragmatic-hive')
    })

    it('each call writes a private kubeconfig of the stored credential and removes it after, also on failure', async () =>
    {
        const root = C.Root()
        try
        {
            const credentials = new FakeCredentials()
            credentials.Values.set(C.Ref, Buffer.from(C.First))
            const exec = new RecordingExec()
            const kubectl = new HostedClusterKubectl(new CredentialKubeconfigExec(credentials, C.Ref, exec, root))
            await kubectl.Get('pragmatic-system', 'configmap/x')
            assert.equal(exec.Runs[0]?.Args[0], '--kubeconfig')
            assert.ok(!exec.Runs[0]?.Args.includes('--context'), 'the shared context is never named')
            assert.equal(exec.Runs[0]?.Kubeconfig, C.First)
            if (process.platform !== 'win32')
            {
                assert.equal(exec.Runs[0]?.Mode, 0o600, 'owner-only')
            }
            assert.deepEqual(readdirSync(root), [], 'removed after use')
            exec.Fail = true
            await assert.rejects(kubectl.Get('pragmatic-system', 'configmap/x'))
            assert.deepEqual(readdirSync(root), [], 'removed after a failure too')
        }
        finally
        {
            rmSync(root, { recursive: true, force: true })
        }
    })

    it('a rotated credential is used from the next call', async () =>
    {
        const root = C.Root()
        try
        {
            const credentials = new FakeCredentials()
            credentials.Values.set(C.Ref, Buffer.from(C.First))
            const exec = new RecordingExec()
            const kubectl = new HostedClusterKubectl(new CredentialKubeconfigExec(credentials, C.Ref, exec, root))
            await kubectl.Get('ns', 'configmap/x')
            credentials.Values.set(C.Ref, Buffer.from(C.Second))
            await kubectl.Get('ns', 'configmap/x')
            assert.deepEqual(exec.Runs.map(run => run.Kubeconfig), [C.First, C.Second])
            credentials.Values.delete(C.Ref)
            await assert.rejects(kubectl.Get('ns', 'configmap/x'), /no cluster credential is stored under clusters\/pl-/, 'deleted (removed placement): refused, naming the reference only')
        }
        finally
        {
            rmSync(root, { recursive: true, force: true })
        }
    })

    it('a port-forward keeps its kubeconfig while its process lives and removes it when it exits', async () =>
    {
        const root = C.Root()
        try
        {
            const credentials = new FakeCredentials()
            credentials.Values.set(C.Ref, Buffer.from(C.First))
            const kubectl = new HostedClusterKubectl(new CredentialKubeconfigExec(credentials, C.Ref, new RecordingExec(), root))
            const spawner = new FakeSpawner()
            const forward = await kubectl.PortForward('env-a', 'svc/server', 7100, spawner)
            assert.equal(forward.LocalPort, 41234)
            assert.equal(spawner.Args[0], '--kubeconfig')
            assert.equal(spawner.Kubeconfig, C.First)
            assert.equal(readdirSync(root).length, 1, 'kept while forwarding')
            spawner.End()
            await new Promise(resolve => setTimeout(resolve, 20))
            assert.deepEqual(readdirSync(root), [])
            assert.ok(!existsSync(spawner.Args[1] as string))
        }
        finally
        {
            rmSync(root, { recursive: true, force: true })
        }
    })
})
