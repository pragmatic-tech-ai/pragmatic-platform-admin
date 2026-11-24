import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The one pin of the platform admin image's golden component descriptor: its fixture file and content digest, which
 * every descriptor test checks against. The descriptor carries the package version, so every release re-pins both.
 */
export class PlatformAdminGolden
{
    public static readonly Fixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'pragmatic-platform-admin.component.json')
    /** At 0.1.12 (core.sealingKey since 0.1.12's C5.1: PRAGMATIC_ADMIN_SEALING_KEY_FILE). */
    public static readonly Digest = 'sha256:d960b4758154077e01a70a89f78ccbd75fe215a64b1b7b484cfbf32d3b66d814'
}
