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

/**
 * The public, secret-free command a customer runs to install the engine: the pragmatic-engine Helm chart at the
 * platform release the tenant admits, into `pragmatic-system`; a Standalone hive also sets `level=standalone`. It never
 * carries a code or a secret (the enrolment code is typed into the engine's console).
 */
export class EngineInstallCommand
{
    public static readonly Chart = 'oci://ghcr.io/pragmatic-tech-ai/charts/pragmatic-engine'
    private static readonly Install = 'helm install pragmatic-engine '
    private static readonly VersionFlag = ' --version '
    private static readonly Namespace = ' --namespace pragmatic-system --create-namespace'
    private static readonly StandaloneFlag = ' --set level=standalone'
    private static readonly ReleasePattern = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/

    public static For(level: HiveLevel, release: string): string
    {
        const E = EngineInstallCommand
        if (!E.ReleasePattern.test(release))
        {
            throw new InvalidInstallReleaseError()
        }
        const command = E.Install + E.Chart + E.VersionFlag + release + E.Namespace
        return level === HiveLevel.Standalone ? command + E.StandaloneFlag : command
    }
}
