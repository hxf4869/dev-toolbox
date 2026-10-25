import { flushPromises, mount } from '@vue/test-utils'
import { createMemoryHistory } from 'vue-router'

import { createAppRouter } from './router'

// jsdom 没有布局引擎,scrollIntoView 未实现。这里只替换为最小可观察 spy,
// 证明真实 router 导航驱动的是哪个 DOM 滚动入口;实际几何由根 IAB 验证。
function stubElementScrollIntoView() {
  const spy = vi.fn()
  Object.defineProperty(Element.prototype, 'scrollIntoView', {
    configurable: true,
    writable: true,
    value: spy,
  })
  return spy
}

async function mountShell(router: ReturnType<typeof createAppRouter>) {
  const wrapper = mount(
    {
      template: `<div class="shell"><main id="main-content" class="shell__main"><RouterView /></main></div>`,
    },
    { attachTo: document.body, global: { plugins: [router] } },
  )
  await flushPromises()
  return wrapper
}

describe('router scroll behavior against the shell main scroll container', () => {
  let scrollIntoView: ReturnType<typeof vi.fn>

  beforeEach(() => {
    scrollIntoView = stubElementScrollIntoView()
  })

  afterEach(() => {
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView
    document.body.innerHTML = ''
  })

  it('scrolls a cross-page help hash target into view inside the main container', async () => {
    const router = createAppRouter(createMemoryHistory())
    await router.push('/nowhere-404')
    await router.isReady()
    const wrapper = await mountShell(router)

    await router.push('/help#boundaries')
    await flushPromises()

    const target = document.getElementById('boundaries')
    expect(target).not.toBeNull()
    expect(scrollIntoView).toHaveBeenCalledTimes(1)
    expect(scrollIntoView.mock.instances[0]).toBe(target)
    wrapper.unmount()
  })

  it('scrolls between help hashes on the same page', async () => {
    const router = createAppRouter(createMemoryHistory())
    await router.push('/help#capture-search')
    await router.isReady()
    const wrapper = await mountShell(router)
    await flushPromises()
    scrollIntoView.mockClear()

    await router.push('/help#boundaries')
    await flushPromises()

    const target = document.getElementById('boundaries')
    expect(scrollIntoView).toHaveBeenCalledTimes(1)
    expect(scrollIntoView.mock.instances[0]).toBe(target)
    wrapper.unmount()
  })

  it('returns a no-hash page to the top of the main scroll container', async () => {
    const router = createAppRouter(createMemoryHistory())
    await router.push('/help#boundaries')
    await router.isReady()
    const wrapper = await mountShell(router)
    const main = document.getElementById('main-content') as HTMLElement & {
      scrollTo: (options?: ScrollToOptions) => void
    }
    const scrollTo = vi.fn()
    main.scrollTo = scrollTo

    await router.push('/nowhere-404')
    await flushPromises()

    expect(scrollTo).toHaveBeenCalledWith({ top: 0 })
    expect(scrollIntoView).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('does not throw when the hash target does not exist', async () => {
    const router = createAppRouter(createMemoryHistory())
    await router.push('/nowhere-404')
    await router.isReady()
    const wrapper = await mountShell(router)

    await expect(router.push('/help#does-not-exist')).resolves.toBeUndefined()
    await flushPromises()

    expect(scrollIntoView).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('does not throw when the shell scroll container is not mounted yet', async () => {
    const router = createAppRouter(createMemoryHistory())

    await expect(router.push('/help#boundaries')).resolves.toBeUndefined()
    await router.isReady()
    await flushPromises()

    expect(scrollIntoView).not.toHaveBeenCalled()
  })
})
