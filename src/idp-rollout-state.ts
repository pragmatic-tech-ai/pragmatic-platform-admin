/** How a Deployment's roll stands, as its status tells it. */
export enum IdpRolloutState
{
    /** Every replica of the current template is updated and available. */
    Ready = 'ready',
    /** The controller gave up: no progress within the Deployment's progress deadline (the new pods never became ready). */
    Failed = 'failed',
    /** Neither yet (still pulling, starting or migrating). */
    Rolling = 'rolling',
}

type DeploymentStatus = {
    metadata?: { generation?: number }
    spec?: { replicas?: number; template?: { spec?: { containers?: Array<{ name?: string; image?: string }> } } }
    status?: { observedGeneration?: number; replicas?: number; updatedReplicas?: number; availableReplicas?: number; conditions?: Array<{ type?: string; status?: string; reason?: string }> }
}
type PodList = { items?: Array<{ spec?: { containers?: Array<{ name?: string; image?: string }> }; status?: { containerStatuses?: ContainerStatus[] } }> }
type ContainerStatus = { name?: string; state?: ContainerState; lastState?: ContainerState }
type ContainerState = { waiting?: { reason?: string }; terminated?: { exitCode?: number; reason?: string; message?: string } }

/**
 * Reads the realm sign-in service's Deployment and pods as kubectl returns them (JSON): whether its roll is ready, failed
 * (the controller's ProgressDeadlineExceeded: a confirmed failure, never a slow start) or still rolling; whether a
 * running one was available (worth putting back); and why the new pods failed (their termination message, which the
 * container writes from its last log lines), read before they are replaced.
 */
export class IdpRolloutStatus
{
    private static readonly Progressing = 'Progressing'
    private static readonly False = 'False'
    private static readonly DeadlineExceeded = 'ProgressDeadlineExceeded'
    private static readonly ReasonSeparator = '; '
    private static readonly ExitPrefix = 'exit '
    private static readonly Colon = ': '
    private static readonly MaxReasonLength = 600
    private static readonly NoText = ''

    public static StateOf(deploymentJson: string | undefined): IdpRolloutState
    {
        const R = IdpRolloutState
        const I = IdpRolloutStatus
        if (deploymentJson === undefined) return R.Rolling
        const d = JSON.parse(deploymentJson) as DeploymentStatus
        const wanted = d.spec?.replicas ?? 1
        const s = d.status ?? {}
        const current = (s.observedGeneration ?? 0) >= (d.metadata?.generation ?? 0)
        if (current && (s.updatedReplicas ?? 0) >= wanted && (s.availableReplicas ?? 0) >= wanted && (s.replicas ?? 0) <= wanted) return R.Ready
        const stalled = (s.conditions ?? []).some(c => c.type === I.Progressing && c.status === I.False && c.reason === I.DeadlineExceeded)
        return current && stalled ? R.Failed : R.Rolling
    }

    /** Whether the Deployment (as it was before the release's template) had an available replica. */
    public static WasAvailable(deploymentJson: string | undefined): boolean
    {
        if (deploymentJson === undefined) return false
        return ((JSON.parse(deploymentJson) as DeploymentStatus).status?.availableReplicas ?? 0) > 0
    }

    /** The termination messages (or waiting reasons) of the pods whose `container` runs `image`; empty when none tells. */
    public static ReasonOf(podsJson: string | undefined, container: string, image: string): string
    {
        const I = IdpRolloutStatus
        if (podsJson === undefined) return I.NoText
        const reasons = new Set<string>()
        for (const pod of (JSON.parse(podsJson) as PodList).items ?? [])
        {
            if (!(pod.spec?.containers ?? []).some(c => c.name === container && c.image === image)) continue
            const status = (pod.status?.containerStatuses ?? []).find(c => c.name === container)
            const reason = I.TerminationOf(status?.lastState) ?? I.TerminationOf(status?.state) ?? status?.state?.waiting?.reason
            if (reason !== undefined && reason !== I.NoText) reasons.add(reason)
        }
        const text = [...reasons].join(I.ReasonSeparator)
        return text.length > I.MaxReasonLength ? text.slice(0, I.MaxReasonLength) : text
    }

    private static TerminationOf(state: ContainerState | undefined): string | undefined
    {
        const I = IdpRolloutStatus
        const t = state?.terminated
        if (t === undefined) return undefined
        const message = (t.message ?? I.NoText).trim()
        return message !== I.NoText ? message : I.ExitPrefix + String(t.exitCode ?? I.NoText) + (t.reason === undefined ? I.NoText : I.Colon + t.reason)
    }
}
