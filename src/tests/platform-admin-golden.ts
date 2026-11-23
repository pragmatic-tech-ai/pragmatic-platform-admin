import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The one pin of the platform admin image's golden component descriptor: its fixture file and content digest, which
 * every descriptor test checks against. The descriptor carries the package version, so every release re-pins both.
 */
export class PlatformAdminGolden
{
    public static readonly Fixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'pragmatic-platform-admin.component.json')
    /** At 0.1.3: the entitlements and customerApi options and the internal listener's allowed hosts (D4), and the version. */
    public static readonly Digest = 'sha256:843ddbf9355a9dd1878af097230f13c61d0116926f3d1e1163feee9431a735f3'
}
