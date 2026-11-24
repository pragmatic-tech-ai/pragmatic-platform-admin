import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The one pin of the platform admin image's golden component descriptor: its fixture file and content digest, which
 * every descriptor test checks against. The descriptor carries the package version, so every release re-pins both.
 */
export class PlatformAdminGolden
{
    public static readonly Fixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'pragmatic-platform-admin.component.json')
    /** At 0.1.4: tenantPlane.desktopRealmSignIn (Plexus signs in at the tenant realm, E.s S4) and the version. */
    public static readonly Digest = 'sha256:8737bdd22d68331b7b0e90bda886a760ac2bc84ef613adf50d8f41447fae82fa'
}
