// Calls `resume` whenever the browser shows the page again (`pageshow`, including a return through the back/forward
// cache) until disposed.
export class PageShowListener
{
    private static readonly PageShowEvent = 'pageshow'

    public constructor(private readonly target: EventTarget, private readonly resume: () => void)
    {
        target.addEventListener(PageShowListener.PageShowEvent, this.resume)
    }

    public dispose(): void
    {
        this.target.removeEventListener(PageShowListener.PageShowEvent, this.resume)
    }
}
