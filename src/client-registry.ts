import { JsonRecordStore, type IRecordMap } from '@pragmatic-tech-ai/pragmatic-tenant-plane'
import type { ClientRecord } from './platform-records.js'

export class ClientRegistry extends JsonRecordStore<ClientRecord>
{
    public static readonly RootKey = 'clients'

    public constructor(location: string | IRecordMap<ClientRecord>)
    {
        super(location, ClientRegistry.RootKey)
    }
}
