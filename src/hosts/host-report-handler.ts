import { AgentExchangeRefusal, HostReport, MessageKind, ParticipantRole, type IBodyDecoder, type VerifiedMessage } from '@pragmatic-tech-ai/pragmatic-hive-protocol'
import { AgentExchangeRefusedError, type AgentAnswer, type IAgentMessageHandler } from '../hive-channel/platform-agent-exchange.js'
import type { HostRecord } from './host-record.js'

/** Where a host's verified report is kept (HostRegistry). */
export interface IHostReportSink
{
    Get(id: string): HostRecord | undefined
    RecordReport(id: string, report: HostReport): Promise<HostRecord>
}

/**
 * A host agent's signed capacity report (C5.1, every 30 s): verified against the host's registered key, then kept as
 * the host's latest report (health, total and allocatable resources, hive slots, its placements' states), from which the
 * scheduler reads freshness and free slots. Closed shape, numbers and enums only. Acknowledged with no answer (204).
 */
export class HostReportHandler implements IAgentMessageHandler<HostReport>
{
    public readonly Kind = MessageKind.HostReport
    public readonly Issuer = ParticipantRole.Host
    public readonly Decoder: IBodyDecoder<HostReport> = HostReport

    public constructor(private readonly hosts: IHostReportSink)
    {
    }

    public async Handle(message: VerifiedMessage<HostReport>): Promise<AgentAnswer | null>
    {
        if (this.hosts.Get(message.Issuer.Id) === undefined)
        {
            throw new AgentExchangeRefusedError(AgentExchangeRefusal.NotVerified)
        }
        await this.hosts.RecordReport(message.Issuer.Id, message.Body)
        return null
    }
}
