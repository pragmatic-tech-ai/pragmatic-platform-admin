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
    public static readonly Digest = 'sha256:7e2ee5c8752751389b534429ce00232aa872c74dbaf10496813a24d8c533ddac'
}
