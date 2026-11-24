import { X509Certificate } from 'node:crypto'

/**
 * The name a loopback client (the docker IdP's health probe, the in-hive admin over a port-forward) verifies an IdP's
 * DevCa certificate by, read from the CA it pins. A CA minted on pragmatic-shared 0.18.14 or later permits the DNS name
 * `localhost` (its leaves name `localhost`, never an IP); every older one (with an IP subtree, or from before DevCa had
 * name constraints) does not, and its leaves carry the IP SAN 127.0.0.1 without `localhost`. The chain is always verified
 * against the pinned CA; only the expected name follows the CA's generation, so IdPs minted before 0.18.14 keep working
 * until they are re-minted.
 */
export class IdpLoopbackHost
{
    public static readonly Localhost = 'localhost'
    public static readonly LoopbackIp = '127.0.0.1'
    /** id-ce-nameConstraints (2.5.29.30) as DER: OBJECT IDENTIFIER, length 3, 55 1D 1E. */
    private static readonly NameConstraintsOid = Buffer.from([0x06, 0x03, 0x55, 0x1d, 0x1e])
    private static readonly LocalhostBytes = Buffer.from('localhost', 'ascii')
    private static readonly BooleanTag = 0x01
    private static readonly OctetStringTag = 0x04
    private static readonly SequenceTag = 0x30
    private static readonly PermittedTag = 0xa0
    private static readonly DnsNameTag = 0x82
    private static readonly LongLengthFlag = 0x80
    private static readonly LengthBitsMask = 0x7f
    private static readonly MaxLengthBytes = 4
    private static readonly ByteRadix = 256

    /** `localhost` for a CA that permits it (0.18.14 or later), else `127.0.0.1`. A CA that does not parse answers
     *  `localhost`: verification against it fails either way. */
    public static For(caPem: string | Buffer): string
    {
        const H = IdpLoopbackHost
        let der: Buffer
        try
        {
            der = new X509Certificate(caPem).raw
        }
        catch
        {
            return H.Localhost
        }
        return H.PermitsLocalhost(der) ? H.Localhost : H.LoopbackIp
    }

    /** Whether the certificate's name constraints permit the DNS name `localhost`. Malformed DER answers false. */
    public static PermitsLocalhost(der: Buffer): boolean
    {
        const H = IdpLoopbackHost
        const at = der.indexOf(H.NameConstraintsOid)
        if (at < 0)
        {
            return false
        }
        let offset = at + H.NameConstraintsOid.length
        if (der[offset] === H.BooleanTag)
        {
            offset = H.End(der, offset, der.length)
        }
        if (der[offset] !== H.OctetStringTag)
        {
            return false
        }
        const constraints = H.ContentStart(der, offset)
        if (der[constraints] !== H.SequenceTag)
        {
            return false
        }
        const end = H.End(der, constraints, der.length)
        let child = H.ContentStart(der, constraints)
        while (child < end)
        {
            if (der[child] === H.PermittedTag)
            {
                return H.AnyLocalhostSubtree(der, H.ContentStart(der, child), H.End(der, child, end))
            }
            child = H.End(der, child, end)
        }
        return false
    }

    /** Whether a GeneralSubtrees run [from, to) holds a subtree whose base is the dNSName `localhost`. */
    private static AnyLocalhostSubtree(der: Buffer, from: number, to: number): boolean
    {
        const H = IdpLoopbackHost
        let subtree = from
        while (subtree < to)
        {
            const base = H.ContentStart(der, subtree)
            if (der[subtree] === H.SequenceTag && der[base] === H.DnsNameTag)
            {
                const name = der.subarray(H.ContentStart(der, base), H.End(der, base, to))
                if (name.equals(H.LocalhostBytes))
                {
                    return true
                }
            }
            subtree = H.End(der, subtree, to)
        }
        return false
    }

    /** The offset of the content of the TLV at `offset`. */
    private static ContentStart(der: Buffer, offset: number): number
    {
        const H = IdpLoopbackHost
        const first = der[offset + 1] ?? 0
        return first < H.LongLengthFlag ? offset + 2 : offset + 2 + (first & H.LengthBitsMask)
    }

    /** The offset just past the TLV at `offset`, never beyond `limit` (a malformed length ends the walk). */
    private static End(der: Buffer, offset: number, limit: number): number
    {
        const H = IdpLoopbackHost
        const first = der[offset + 1] ?? 0
        if (first < H.LongLengthFlag)
        {
            return Math.min(offset + 2 + first, limit)
        }
        const bytes = first & H.LengthBitsMask
        if (bytes === 0 || bytes > H.MaxLengthBytes)
        {
            return limit
        }
        let length = 0
        for (let i = 0; i < bytes; i++)
        {
            length = length * H.ByteRadix + (der[offset + 2 + i] ?? 0)
        }
        return Math.min(offset + 2 + bytes + length, limit)
    }
}
