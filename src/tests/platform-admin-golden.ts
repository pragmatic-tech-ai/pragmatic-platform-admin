import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The one pin of the platform admin image's golden component descriptor: its fixture file and content digest, which
 * every descriptor test checks against. The descriptor carries the package version, so every release re-pins both.
 */
export class PlatformAdminGolden
{
    public static readonly Fixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'pragmatic-platform-admin.component.json')
    /** At 0.1.2: the operatorSignIn option (operator sign-in through the staff realm, 2.6) and the version. */
    public static readonly Digest = 'sha256:17e053cf9109e135eb6e7760b9ef603a839f4815ba07e5b9c91a1eabb47f5d61'
}
