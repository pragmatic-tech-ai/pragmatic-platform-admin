import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { KubectlCli, NodeExecFile, type IExecFile, type IProcessSpawner, type ISpawnedProcess, type PortForwardResult } from '@pragmatic-tech-ai/pragmatic-kube'

/** Where a hosted hive's cluster credential is read (the sealed secret store, under `clusters/<placement>`). */
export interface IClusterCredentialSource
{
    Get(ref: string): Promise<Buffer | undefined>
}

/** The hive's cluster credential is not in the secret store (not handed over yet, or deleted). Names the reference only. */
export class HostedCredentialMissingError extends Error
{
    private static readonly ErrorName = 'HostedCredentialMissingError'
    private static readonly MessagePrefix = 'no cluster credential is stored under '

    public constructor(ref: string)
    {
        super(HostedCredentialMissingError.MessagePrefix + ref)
        this.name = HostedCredentialMissingError.ErrorName
    }
}

/**
 * One use's kubeconfig (C5.1): the credential written to a fresh private directory (0700) as a 0600 file under the OS
 * temp folder (a tmpfs on frontdoor), removed after the use, also when the use fails. Never shared between uses, so a
 * rotated credential is what the next use reads.
 */
export class PrivateKubeconfig
{
    private static readonly DirPrefix = 'pragmatic-kubeconfig-'
    private static readonly FileName = 'kubeconfig'
    private static readonly DirMode = 0o700
    private static readonly FileMode = 0o600
    /** Create only: never write into a file that already exists. */
    private static readonly CreateOnly = 'wx'

    private constructor(private readonly dir: string, public readonly Path: string)
    {
    }

    public static async Write(credential: Buffer, root: string = tmpdir()): Promise<PrivateKubeconfig>
    {
        const P = PrivateKubeconfig
        const dir = await mkdtemp(join(root, P.DirPrefix))
        try
        {
            await chmod(dir, P.DirMode)
            const path = join(dir, P.FileName)
            await writeFile(path, credential, { mode: P.FileMode, flag: P.CreateOnly })
            return new PrivateKubeconfig(dir, path)
        }
        catch (error)
        {
            await rm(dir, { recursive: true, force: true })
            throw error
        }
    }

    public async Remove(): Promise<void>
    {
        await rm(this.dir, { recursive: true, force: true })
    }
}

/**
 * Runs kubectl with a hosted hive's own credential: each run reads the credential from the secret store, writes a
 * PrivateKubeconfig and rewrites KubectlCli's leading `--context <name>` to `--kubeconfig <file>` (the handed-over
 * kubeconfig names its one context as current), then removes the file whatever the outcome.
 */
export class CredentialKubeconfigExec implements IExecFile
{
    private static readonly ContextFlag = '--context'
    private static readonly KubeconfigFlag = '--kubeconfig'

    public constructor(private readonly credentials: IClusterCredentialSource, private readonly ref: string, private readonly inner: IExecFile = new NodeExecFile(), private readonly root?: string)
    {
    }

    public async Run(file: string, args: readonly string[], stdin?: string): Promise<{ stdout: string; stderr: string }>
    {
        const kubeconfig = await this.Open()
        try
        {
            return await this.inner.Run(file, CredentialKubeconfigExec.Rewrite(args, kubeconfig.Path), stdin)
        }
        finally
        {
            await kubeconfig.Remove()
        }
    }

    /** A fresh kubeconfig of the stored credential (the caller removes it). */
    public async Open(): Promise<PrivateKubeconfig>
    {
        const credential = await this.credentials.Get(this.ref)
        if (credential === undefined)
        {
            throw new HostedCredentialMissingError(this.ref)
        }
        try
        {
            return await PrivateKubeconfig.Write(credential, this.root)
        }
        finally
        {
            credential.fill(0)
        }
    }

    /** `--context <name> ...rest` becomes `--kubeconfig <path> ...rest`; anything else gets the flag in front. */
    public static Rewrite(args: readonly string[], path: string): string[]
    {
        const C = CredentialKubeconfigExec
        const rest = args[0] === C.ContextFlag ? args.slice(2) : [...args]
        return [C.KubeconfigFlag, path, ...rest]
    }
}

/** A spawner whose kubectl runs with one PrivateKubeconfig (a port-forward's, kept until its process exits). */
export class KubeconfigSpawner implements IProcessSpawner
{
    public constructor(private readonly inner: IProcessSpawner, private readonly path: string)
    {
    }

    public Spawn(file: string, args: readonly string[]): ISpawnedProcess
    {
        return this.inner.Spawn(file, CredentialKubeconfigExec.Rewrite(args, this.path))
    }
}

/**
 * A hosted hive's kubectl (C5.1): every KubectlCli verb through CredentialKubeconfigExec (a private kubeconfig per
 * call), and a port-forward whose kubeconfig lives as long as the forwarding process (removed when it exits, or at once
 * when it never came up).
 */
export class HostedClusterKubectl extends KubectlCli
{
    /** The context name KubectlCli is built with; the rewrite replaces it with the credential's kubeconfig. */
    public static readonly ContextName = 'hosted'

    public constructor(private readonly credentialExec: CredentialKubeconfigExec)
    {
        super(HostedClusterKubectl.ContextName, credentialExec)
    }

    public override async PortForward(namespace: string, target: string, remotePort: number, spawner: IProcessSpawner): Promise<PortForwardResult>
    {
        const kubeconfig = await this.credentialExec.Open()
        let result: PortForwardResult
        try
        {
            result = await super.PortForward(namespace, target, remotePort, new KubeconfigSpawner(spawner, kubeconfig.Path))
        }
        catch (error)
        {
            await kubeconfig.Remove()
            throw error
        }
        result.Process.OnExit(() => { void kubeconfig.Remove() })
        return result
    }
}
