import { HiveLevel } from '@pragmatic-tech-ai/pragmatic-customer-api-contract'

/** The release named in an install command is not a release version (it would not be safe on a command line). */
export class InvalidInstallReleaseError extends Error
{
    private static readonly ErrorName = 'InvalidInstallReleaseError'
    private static readonly Text = 'Not a platform release version'

    public constructor()
    {
        super(InvalidInstallReleaseError.Text)
        this.name = InvalidInstallReleaseError.ErrorName
    }
}

/** The tenant named in an install command is not a chart `tenant.id` (it would not be safe on a command line). */
export class InvalidInstallTenantError extends Error
{
    private static readonly ErrorName = 'InvalidInstallTenantError'
    private static readonly Text = 'Not a tenant id the engine chart takes'

    public constructor()
    {
        super(InvalidInstallTenantError.Text)
        this.name = InvalidInstallTenantError.ErrorName
    }
}

/**
 * The public, secret-free command a customer runs to install the engine: the pragmatic-engine Helm chart at the
 * platform release the tenant admits, into `pragmatic-system`, naming the tenant (the realm id of the engine's sign-in
 * service from its first start) and placeholders for the console host and the TLS Secret (a kubernetes.io/tls Secret the
 * customer creates in pragmatic-system, covering the console, the sign-in service and *.<base domain>); a Standalone hive also sets
 * `level=standalone`. It never carries a code or a secret (the enrolment code is typed into the engine's console).
 */
export class EngineInstallCommand
{
    public static readonly Chart = 'oci://ghcr.io/pragmatic-tech-ai/charts/pragmatic-engine'
    private static readonly Install = 'helm install pragmatic-engine '
    private static readonly VersionFlag = ' --version '
    private static readonly Namespace = ' --namespace pragmatic-system --create-namespace'
    private static readonly StandaloneFlag = ' --set level=standalone'
    private static readonly TenantFlag = ' --set tenant.id='
    /** The literal placeholders the customer replaces: their console's host, and the TLS Secret that covers it (no shell metacharacters). */
    public static readonly ConsoleHostPlaceholder = 'YOUR-CONSOLE-HOST'
    public static readonly TlsSecretPlaceholder = 'YOUR-TLS-SECRET'
    private static readonly ConsoleHostFlag = ' --set console.host='
    private static readonly TlsSecretFlag = ' --set tls.secretName='
    private static readonly ReleasePattern = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/
    /** The chart's `tenant.id` (values.schema.json). */
    private static readonly TenantPattern = /^[a-z][a-z0-9-]{1,30}[a-z0-9]$/

    public static For(level: HiveLevel, release: string, tenantId: string): string
    {
        const E = EngineInstallCommand
        if (!E.ReleasePattern.test(release))
        {
            throw new InvalidInstallReleaseError()
        }
        if (!E.TenantPattern.test(tenantId))
        {
            throw new InvalidInstallTenantError()
        }
        const command = E.Install + E.Chart + E.VersionFlag + release + E.Namespace + E.TenantFlag + tenantId + E.ConsoleHostFlag + E.ConsoleHostPlaceholder + E.TlsSecretFlag + E.TlsSecretPlaceholder
        return level === HiveLevel.Standalone ? command + E.StandaloneFlag : command
    }
}
