import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** A CA and server cert shaped as DevCa minted them before pragmatic-shared 0.18.14: a permitted IP subtree, the IP SAN. */
export type LegacyDevCaFiles = { readonly caFile: string; readonly certFile: string; readonly keyFile: string }

/**
 * Mints, with the openssl CLI, an IdP certificate pair as a pre-0.18.14 DevCa did (the shape every IdP of an earlier install
 * still serves): the CA permits its host and the IP subtree 127.0.0.1/32; the leaf names the host and IP 127.0.0.1, no
 * `localhost`. For the loopback clients' compatibility tests.
 */
export class LegacyDevCa
{
    public static readonly Openssl = 'openssl'
    public static readonly CaFileName = 'ca.crt'
    public static readonly CaKeyFileName = 'ca.key'
    public static readonly CertFileName = 'server.crt'
    public static readonly KeyFileName = 'server.key'
    public static readonly CsrFileName = 'server.csr'
    public static readonly ExtFileName = 'server.ext'
    private static readonly Key = ['-newkey', 'rsa:2048', '-nodes']
    private static readonly Days = '2'
    private static readonly CaSubject = '/CN=pragmatic-idp-dev-ca'
    private static readonly SubjectPrefix = '/CN='
    private static readonly CaBasic = 'basicConstraints=critical,CA:TRUE,pathlen:0'
    private static readonly CaUsage = 'keyUsage=critical,keyCertSign,cRLSign'
    private static readonly ConstraintsPrefix = 'nameConstraints=critical,permitted;DNS:'
    private static readonly ConstraintsSuffix = ',permitted;IP:127.0.0.1/255.255.255.255'
    private static readonly SanPrefix = 'subjectAltName=DNS:'
    private static readonly SanSuffix = ',IP:127.0.0.1\nbasicConstraints=CA:FALSE\n'
    private static readonly Piped = 'pipe'

    /** `caSubject` names the CA (another subject than DevCa's mints an unrelated CA, for trust that is not the IdP's). */
    public static MintAt(dir: string, host: string, caSubject: string = LegacyDevCa.CaSubject): LegacyDevCaFiles
    {
        const L = LegacyDevCa
        const at = (name: string): string => join(dir, name)
        L.Run(['req', '-x509', ...L.Key, '-keyout', at(L.CaKeyFileName), '-out', at(L.CaFileName), '-days', L.Days, '-subj', caSubject,
            '-addext', L.CaBasic, '-addext', L.CaUsage, '-addext', L.ConstraintsPrefix + host + L.ConstraintsSuffix])
        L.Run(['req', ...L.Key, '-keyout', at(L.KeyFileName), '-out', at(L.CsrFileName), '-subj', L.SubjectPrefix + host])
        writeFileSync(at(L.ExtFileName), L.SanPrefix + host + L.SanSuffix)
        L.Run(['x509', '-req', '-in', at(L.CsrFileName), '-CA', at(L.CaFileName), '-CAkey', at(L.CaKeyFileName), '-CAcreateserial',
            '-out', at(L.CertFileName), '-days', L.Days, '-extfile', at(L.ExtFileName)])
        return { caFile: at(L.CaFileName), certFile: at(L.CertFileName), keyFile: at(L.KeyFileName) }
    }

    private static Run(args: readonly string[]): void
    {
        execFileSync(LegacyDevCa.Openssl, [...args], { stdio: LegacyDevCa.Piped })
    }
}
