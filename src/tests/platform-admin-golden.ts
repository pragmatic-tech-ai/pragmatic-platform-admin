import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The one pin of the platform admin image's golden component descriptor: its fixture file and content digest, which
 * every descriptor test checks against. The descriptor carries the package version, so every release re-pins both.
 */
export class PlatformAdminGolden
{
    public static readonly Fixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'pragmatic-platform-admin.component.json')
    /** At 0.1.11 with core.sealingKey (C5.1: PRAGMATIC_ADMIN_SEALING_KEY_FILE). */
    public static readonly Digest = 'sha256:d0664744fec6abc4ad9020471f5f5c3a6c01e350e8fd18ee5dfa557a26f7c2eb'
}
