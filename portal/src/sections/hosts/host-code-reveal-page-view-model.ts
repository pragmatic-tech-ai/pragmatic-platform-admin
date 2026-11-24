import { OneTimeSecretPageViewModel } from '@pragmatic-tech-ai/pragmatic-app-shell'
import { PortalDates } from '../../portal-dates.js'
import type { HostsSectionService } from './hosts-section-service.js'

// A host enrolment code, shown once (see OneTimeSecretPageViewModel): the
// operator puts it in the new host agent's code file. Confirming clears it and
// returns to the host list.
export class HostCodeRevealPageViewModel extends OneTimeSecretPageViewModel
{
    private static readonly TitleText = 'Host code issued'
    private static readonly NoticeTemplate = 'This code enrols one host agent, once, until {expires} (UTC). Put it in the file the agent reads as PRAGMATIC_HOST_ENROLMENT_CODE_FILE now: it is shown once and cannot be shown again.'
    private static readonly ExpiresToken = '{expires}'
    private static readonly ConfirmText = 'Back to hosts'

    public constructor(private readonly section: HostsSectionService, code: string, private readonly expiresAt: string)
    {
        super(section, code)
    }

    public get Title(): string
    {
        return HostCodeRevealPageViewModel.TitleText
    }

    public get Notice(): string
    {
        const H = HostCodeRevealPageViewModel
        return H.NoticeTemplate.replace(H.ExpiresToken, PortalDates.DateTimeLabel(this.expiresAt))
    }

    public get ConfirmLabel(): string
    {
        return HostCodeRevealPageViewModel.ConfirmText
    }

    protected override OnSaved(): void
    {
        void this.section.BackAndRefresh()
    }
}
