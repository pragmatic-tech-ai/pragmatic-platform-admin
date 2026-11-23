import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { PageShowListener } from '../page-show-listener.js'

describe('PageShowListener', () =>
{
    const PageShow = 'pageshow'

    it('resumes on every pageshow until disposed', () =>
    {
        const target = new EventTarget()
        let resumed = 0
        const listener = new PageShowListener(target, () => { resumed++ })
        target.dispatchEvent(new Event(PageShow))
        target.dispatchEvent(new Event(PageShow))
        assert.equal(resumed, 2)
        listener.dispose()
        target.dispatchEvent(new Event(PageShow))
        assert.equal(resumed, 2)
    })
})
