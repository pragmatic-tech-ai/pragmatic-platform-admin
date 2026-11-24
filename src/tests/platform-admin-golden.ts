import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The one pin of the platform admin image's golden component descriptor: its fixture file and content digest, which
 * every descriptor test checks against. The descriptor carries the package version, so every release re-pins both.
 */
export class PlatformAdminGolden
{
    public static readonly Fixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'pragmatic-platform-admin.component.json')
    /** At 0.1.9 (the descriptor changes only with the version since 0.1.4's tenantPlane.desktopRealmSignIn, E.s S4). */
    public static readonly Digest = 'sha256:472d2c4494eebeb079cee1fa08bad8001a05a478fd8c0b4cfc21347592c96f2a'
}
