import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The one pin of the platform admin image's golden component descriptor: its fixture file and content digest, which
 * every descriptor test checks against. The descriptor carries the package version, so every release re-pins both.
 */
export class PlatformAdminGolden
{
    public static readonly Fixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'pragmatic-platform-admin.component.json')
    /** At 0.1.1: pragmatic-server's pin (`sha256:bc19deb0…`, the seed commit) with only the version field changed. */
    public static readonly Digest = 'sha256:0a71493f54c0f31867ab4dc7079fea4bca3b3d4b415819a9e65bf71385fa20a0'
}
