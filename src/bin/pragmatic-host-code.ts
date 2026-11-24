import { open, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EnrolmentCodeIssuer } from '../enrolment/enrolment-code-issuer.js'
import { EnrolmentCodeRegistry } from '../enrolment/enrolment-code-record.js'
import { PlatformAdminDatabase, PlatformAdminRegistry } from '../platform-admin-database.js'

/** What the command line asked for. */
export class HostCodeArguments
{
    public constructor(public readonly Out: string)
    {
    }
}

/** The output file exists already: nothing was issued. */
export class HostCodeFileExistsError extends Error
{
    private static readonly ErrorName = 'HostCodeFileExistsError'
    private static readonly Text = 'the output file exists already; nothing was issued'

    public constructor()
    {
        super(HostCodeFileExistsError.Text)
        this.name = HostCodeFileExistsError.ErrorName
    }
}

/** Issues host codes for a machine operator (where no one signs in to the operator console). */
export interface IHostCodeIssuer
{
    IssueHostCode(issuedBy: string): Promise<{ Code: string; ExpiresAt: Date }>
}

/**
 * The machine-side host enrolment code (C5.1), run inside the platform-admin image against the console's own database
 * (`podman exec ... node dist/bin/pragmatic-host-code.js issue-host-code --out <file>`): the same host code POST
 * /api/hosts/enrolment-code issues (EnrolmentCodeIssuer.IssueHostCode: agent kind host, 30 minutes, once), issued by
 * the fixed subject `machine:frontdoor-cli`. The output file is created first (0600, refused when it exists, so nothing
 * is issued then), the code written into it and never printed; only the expiry is printed. The running console finds
 * the code in the database when the host agent redeems it. Exits 2 on a usage error, 3 when the file exists, 1 on any
 * other failure (its message never carries the code).
 */
export class HostCodeBin
{
    public static readonly Command = 'issue-host-code'
    public static readonly OutFlag = '--out'
    public static readonly IssuedBy = 'machine:frontdoor-cli'
    public static readonly UsageExit = 2
    public static readonly ExistsExit = 3
    public static readonly FailedExit = 1
    private static readonly Usage = 'usage: pragmatic-host-code issue-host-code --out <file>   (PRAGMATIC_ADMIN_DATABASE_URL_FILE names the database)'
    private static readonly FailurePrefix = 'pragmatic-host-code: '
    private static readonly ExpiresPrefix = 'host code written; it expires at '
    private static readonly CreateOnly = 'wx'
    private static readonly FileMode = 0o600
    private static readonly ExistsCode = 'EEXIST'
    private static readonly Newline = '\n'
    private static readonly ArgumentsStart = 2

    /** The parsed arguments, or undefined when they are not `issue-host-code --out <file>`. */
    public static Parse(argv: readonly string[]): HostCodeArguments | undefined
    {
        const B = HostCodeBin
        if (argv.length !== 3 || argv[0] !== B.Command || argv[1] !== B.OutFlag || (argv[2] as string).trim() === '')
        {
            return undefined
        }
        return new HostCodeArguments(resolve(argv[2] as string))
    }

    /**
     * Creates `out` (0600, never over an existing file), issues one host code and writes it there; a failed issue
     * removes the file again. Answers the expiry.
     */
    public static async IssueTo(issuer: IHostCodeIssuer, out: string): Promise<Date>
    {
        const B = HostCodeBin
        let file
        try
        {
            file = await open(out, B.CreateOnly, B.FileMode)
        }
        catch (error)
        {
            if ((error as NodeJS.ErrnoException).code === B.ExistsCode)
            {
                throw new HostCodeFileExistsError()
            }
            throw error
        }
        try
        {
            const issued = await issuer.IssueHostCode(B.IssuedBy)
            await file.writeFile(issued.Code + B.Newline)
            await file.close()
            return issued.ExpiresAt
        }
        catch (error)
        {
            await file.close().catch(() => undefined)
            await rm(out, { force: true })
            throw error
        }
    }

    /** Runs the command; answers the process exit code. `issuer` stands in for the database's (tests). */
    public static async Run(argv: readonly string[], env: NodeJS.ProcessEnv, out: (line: string) => void = console.log, err: (line: string) => void = console.error, issuer?: IHostCodeIssuer): Promise<number>
    {
        const B = HostCodeBin
        const args = B.Parse(argv)
        if (args === undefined)
        {
            err(B.Usage)
            return B.UsageExit
        }
        let database: PlatformAdminDatabase | undefined
        try
        {
            let codes = issuer
            if (codes === undefined)
            {
                database = await PlatformAdminDatabase.Open(env)
                const registry = new EnrolmentCodeRegistry(await database.Map(PlatformAdminRegistry.EnrolmentCodes))
                await registry.Load()
                codes = new EnrolmentCodeIssuer(registry)
            }
            const expiresAt = await B.IssueTo(codes, args.Out)
            out(B.ExpiresPrefix + expiresAt.toISOString())
            return 0
        }
        catch (e)
        {
            err(B.FailurePrefix + (e instanceof Error ? e.message : String(e)))
            return e instanceof HostCodeFileExistsError ? B.ExistsExit : B.FailedExit
        }
        finally
        {
            await database?.Close()
        }
    }

    public static IsEntryPoint(): boolean
    {
        return process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])
    }

    public static async Main(): Promise<void>
    {
        process.exitCode = await HostCodeBin.Run(process.argv.slice(HostCodeBin.ArgumentsStart), process.env)
    }
}

if (HostCodeBin.IsEntryPoint())
{
    await HostCodeBin.Main()
}
