import { randomBytes } from 'node:crypto'
import { CustomerIds } from '@pragmatic-tech-ai/pragmatic-customer-api-contract'

/** No free hive id after the allotted tries (a collision every time: practically impossible). */
export class HiveIdExhaustedError extends Error
{
    private static readonly ErrorName = 'HiveIdExhaustedError'
    private static readonly Text = 'no free hive id was found'

    public constructor()
    {
        super(HiveIdExhaustedError.Text)
        this.name = HiveIdExhaustedError.ErrorName
    }
}

/**
 * Allocates an enrolled hive's id (C3.3): `hv` plus 10 lowercase base32 characters (50 random bits), a DNS label and a
 * customer-API hive id (`CustomerIds.HiveIdPattern`), never one already taken.
 */
export class HiveIdAllocator
{
    public static readonly Prefix = 'hv'
    public static readonly Pattern = /^hv[a-z2-7]{10}$/
    private static readonly Alphabet = 'abcdefghijklmnopqrstuvwxyz234567'
    private static readonly Characters = 10
    private static readonly MaxTries = 8
    private static readonly Mask = 31

    public constructor(private readonly taken: (id: string) => boolean, private readonly random: (size: number) => Buffer = randomBytes)
    {
    }

    public Next(): string
    {
        const H = HiveIdAllocator
        for (let attempt = 0; attempt < H.MaxTries; attempt++)
        {
            const bytes = this.random(H.Characters)
            let id = H.Prefix
            for (let i = 0; i < H.Characters; i++)
            {
                id += H.Alphabet[(bytes[i] as number) & H.Mask]
            }
            if (!this.taken(id) && CustomerIds.HiveIdPattern.test(id))
            {
                return id
            }
        }
        throw new HiveIdExhaustedError()
    }
}
