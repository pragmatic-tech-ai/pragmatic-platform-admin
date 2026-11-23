import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The one pin of the platform admin image's golden component descriptor: its fixture file and content digest, which
 * every descriptor test checks against. The descriptor carries the package version, so every release re-pins both.
 */
export class PlatformAdminGolden
{
    public static readonly Fixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'pragmatic-platform-admin.component.json')
    /** At 0.1.3: the entitlements and customerApi options (D4) and the version. */
    public static readonly Digest = 'sha256:836d311c5f2a1376e9831d310aac9e5b483b5ba3a0cd4636f9048b3e520aa03a'
}
