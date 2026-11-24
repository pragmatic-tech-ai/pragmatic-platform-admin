import { readFileSync } from 'node:fs'
import { SealingKeyPair } from '@pragmatic-tech-ai/pragmatic-hive-protocol'

/** Raised for an unusable PRAGMATIC_ADMIN_SEALING_KEY_FILE. Names the setting and the reason, never key material. */
export class SealingKeyFileError extends Error
{
    private static readonly ErrorName = 'SealingKeyFileError'
    private static readonly Separator = ': '

    public constructor(reason: string)
    {
        super(PlatformSealingKey.EnvVar + SealingKeyFileError.Separator + reason)
        this.name = SealingKeyFileError.ErrorName
    }
}

/**
 * The platform's X25519 sealing key (C5.1): what host agents seal cluster credentials to. One key, one purpose: it is
 * never the Ed25519 signing key. Read once at start from the PKCS#8 PEM file PRAGMATIC_ADMIN_SEALING_KEY_FILE (a
 * mounted secret); unset, the console takes no hosts (the host kinds are absent from the exchange). A file that is
 * set but unusable stops the start, naming the setting only.
 */
export class PlatformSealingKey
{
    public static readonly EnvVar = 'PRAGMATIC_ADMIN_SEALING_KEY_FILE'
    public static readonly OffWarning = 'Hosts are off: PRAGMATIC_ADMIN_SEALING_KEY_FILE names no X25519 sealing key, so no host agent can enrol or hand over a cluster credential.'
    private static readonly Utf8 = 'utf8'
    private static readonly Unreadable = 'file is missing or unreadable'
    private static readonly NotX25519 = 'file is not an X25519 PKCS#8 private key'

    private constructor()
    {
    }

    /** The key pair, or undefined when the setting is unset. */
    public static Of(env: NodeJS.ProcessEnv): SealingKeyPair | undefined
    {
        const S = PlatformSealingKey
        const path = env[S.EnvVar]?.trim() ?? ''
        if (path === '')
        {
            return undefined
        }
        let pem: string
        try
        {
            pem = readFileSync(path, S.Utf8)
        }
        catch
        {
            throw new SealingKeyFileError(S.Unreadable)
        }
        try
        {
            return SealingKeyPair.FromPrivatePem(pem)
        }
        catch
        {
            throw new SealingKeyFileError(S.NotX25519)
        }
    }
}
