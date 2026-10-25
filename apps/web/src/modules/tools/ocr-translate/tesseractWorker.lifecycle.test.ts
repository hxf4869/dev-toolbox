/**
 * Tesseract worker 单例生命周期合同测试（docs/10 §3.3、§3.5）。
 *
 * 用受控 Promise 驱动动态 import 与 createWorker 的真实等待边界：冷加载取消
 * 不漏留 worker、同语言并发只创建一个实例、旧终止完成前不得创建新实例、
 * 已过归属的迟来释放不得影响新归属的进度 sink 与空闲计时；createWorker 启动
 * 失败（已打补丁的 SDK 会拒绝而非永久 pending）时 acquire 拒绝、terminate 正常
 * 完成、后续 acquire 重新创建恢复，且 wrapper 必须给 SDK 传 errorHandler。
 *
 * manager 为真实实现（与 OcrTranslateView.test.ts 相同的静态导入 + vi.mock
 * 'tesseract.js' 形态，mock 确定命中）；文件内共享一个模块单例，每个用例
 * 开始前用 terminateOcrWorker() 把单例复位到无 worker 状态。
 */

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

import * as ocrWorkerModule from './tesseractWorker'

const mocks = vi.hoisted(() => ({
  createWorker: vi.fn(),
}))

vi.mock('tesseract.js', () => ({ createWorker: mocks.createWorker }))

type FakeWorker = {
  recognize: Mock
  terminate: Mock
}

type WorkerModule = typeof ocrWorkerModule

/** createWorker 的受控 gate：调用时登记 resolve/reject，由用例决定放行句柄还是模拟启动失败。 */
type CreationGate = {
  resolve: (worker: FakeWorker) => void
  reject: (reason: unknown) => void
}
let pendingCreations: CreationGate[] = []
/** deferTerminate worker 的受控 terminate 完成信号。 */
let deferredTerminates: (() => void)[] = []

function makeWorker(options: { deferTerminate?: boolean } = {}): FakeWorker {
  const worker: FakeWorker = { recognize: vi.fn(), terminate: vi.fn() }
  if (options.deferTerminate) {
    worker.terminate.mockImplementation(
      () => new Promise<void>((resolve) => { deferredTerminates.push(resolve) }),
    )
  } else {
    worker.terminate.mockImplementation(async () => undefined)
  }
  return worker
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/**
 * fixture 适配：acquire 的返回值可能是裸 worker，也可能是带 release 的归属
 * 句柄；两种形态下都执行被测实现真实的公开释放/取 worker 操作，让断言落在
 * 行为而不是 API 形状上。
 */
function workerOf(acquired: unknown): FakeWorker {
  const withRelease = acquired as { release?: unknown; worker?: unknown }
  if (typeof withRelease?.release === 'function') return withRelease.worker as FakeWorker
  return acquired as FakeWorker
}

function releaseAcquired(mod: WorkerModule, acquired: unknown): void {
  const withRelease = acquired as { release?: unknown }
  if (typeof withRelease?.release === 'function') {
    ;(withRelease as { release: () => void }).release()
    return
  }
  ;(mod as unknown as { releaseOcrWorker?: () => void }).releaseOcrWorker?.()
}

function emitLoggerProgress(progress: number): void {
  const options = mocks.createWorker.mock.calls.at(-1)?.[2] as { logger?: (message: unknown) => void }
  options.logger?.({ status: 'recognizing text', progress })
}

/** 首次 acquire：等 import 落地、createWorker 已调用后放行句柄，再等 acquire 完成。 */
async function createAcquire(
  mod: WorkerModule,
  lang: 'eng' | 'chi_sim+eng',
  sink?: (update: unknown) => void,
): Promise<{ acquired: unknown; worker: FakeWorker }> {
  const pending = mod.acquireOcrWorker(lang, sink)
  await tick()
  expect(mocks.createWorker).toHaveBeenCalled()
  const worker = makeWorker()
  pendingCreations.shift()!.resolve(worker)
  return { acquired: await pending, worker }
}

/** 复用路径 acquire：不触发新的 createWorker，直接等归属返回。 */
async function reuseAcquire(
  mod: WorkerModule,
  lang: 'eng' | 'chi_sim+eng',
  sink?: (update: unknown) => void,
): Promise<unknown> {
  return await mod.acquireOcrWorker(lang, sink)
}

/** 取消竞态下 acquire 允许以取消收尾；settle 保证不悬挂未处理 Promise，不把合法取消当红。 */
async function settleAcquire(promise: Promise<unknown>): Promise<unknown> {
  try {
    return await promise
  } catch {
    return null
  }
}

describe('tesseractWorker 生命周期', () => {
  beforeEach(async () => {
    // 先排干上一用例可能遗留的未决 gate：用例在断言处中止时，单例可能仍持有
    // 未决的创建/终止 Promise，不排干会让下面的 terminate 永远等待。
    for (const gateLeftover of pendingCreations.splice(0)) gateLeftover.resolve(makeWorker())
    for (const resolveLeftover of deferredTerminates.splice(0)) resolveLeftover()
    mocks.createWorker.mockReset()
    mocks.createWorker.mockImplementation(
      () =>
        new Promise<FakeWorker>((resolve, reject) => {
          pendingCreations.push({ resolve, reject })
        }),
    )
    // 复位上一用例留下的 worker/空闲计时/进度 sink，回到无 worker 状态。
    await ocrWorkerModule.terminateOcrWorker()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('冷加载等待中取消：已开始的创建在句柄可用后被实际终止，不漏留', async () => {
    const acquirePending = ocrWorkerModule.acquireOcrWorker('eng', vi.fn())
    const cancelPending = ocrWorkerModule.terminateOcrWorker()
    await tick()
    // 取消发生在创建等待内：允许实现跳过尚未开始的创建（零创建）；
    // 若创建已开始，句柄返回后必须被实际终止，不得转入空闲回收。
    const gate = pendingCreations.shift()
    let lateWorker: FakeWorker | null = null
    if (gate) {
      lateWorker = makeWorker()
      gate.resolve(lateWorker)
    }
    await cancelPending
    await settleAcquire(acquirePending)
    if (lateWorker) {
      expect(lateWorker.terminate).toHaveBeenCalledTimes(1)
    } else {
      expect(mocks.createWorker).not.toHaveBeenCalled()
    }
  })

  it('冷加载等待中同语言并发 acquire：只创建一个 worker，进度归最新归属', async () => {
    // 两次 acquire 都在动态 import/创建等待窗口内发起，覆盖原 import 等待窗口；
    // 等待窗口内的第二个同语言 acquire 必须复用登记中的创建，不再第二次创建，
    // 且首个创建的异步续体不得把进度 sink 回写为旧归属。
    const sink1 = vi.fn()
    const sink2 = vi.fn()
    const first = ocrWorkerModule.acquireOcrWorker('eng', sink1)
    const second = ocrWorkerModule.acquireOcrWorker('eng', sink2)
    await tick()
    expect(mocks.createWorker).toHaveBeenCalledTimes(1)
    const shared = makeWorker()
    pendingCreations.shift()!.resolve(shared)
    const [acquiredFirst, acquiredSecond] = await Promise.all([first, second])
    expect(workerOf(acquiredFirst)).toBe(shared)
    expect(workerOf(acquiredSecond)).toBe(shared)
    emitLoggerProgress(0.5)
    expect(sink2).toHaveBeenCalledTimes(1)
    expect(sink1).not.toHaveBeenCalled()
  })

  it('旧 worker 终止完成前不得创建新 worker（快速离页重进）', async () => {
    const first = ocrWorkerModule.acquireOcrWorker('eng', vi.fn())
    await tick()
    const oldWorker = makeWorker({ deferTerminate: true })
    pendingCreations.shift()!.resolve(oldWorker)
    await first
    const cancelPending = ocrWorkerModule.terminateOcrWorker()
    const reenterPending = ocrWorkerModule.acquireOcrWorker('eng', vi.fn())
    await tick()
    expect(mocks.createWorker).toHaveBeenCalledTimes(1)
    deferredTerminates.shift()!()
    await cancelPending
    await tick()
    expect(mocks.createWorker).toHaveBeenCalledTimes(2)
    const newWorker = makeWorker()
    pendingCreations.shift()!.resolve(newWorker)
    const acquired = await reenterPending
    expect(workerOf(acquired)).toBe(newWorker)
    expect(oldWorker.terminate).toHaveBeenCalledTimes(1)
  })

  it('终止进行中的新 acquire 再离页：不漏留新创建，旧进度不串入新 sink', async () => {
    const acquireA = ocrWorkerModule.acquireOcrWorker('eng', vi.fn())
    await tick()
    // 离页 A：terminate 等待旧句柄；新页 B 的 acquire 在旧终止期间发起。
    const terminateA = ocrWorkerModule.terminateOcrWorker()
    const sinkB = vi.fn()
    const acquireB = ocrWorkerModule.acquireOcrWorker('eng', sinkB)
    // B 等待旧终止期间，旧 A 的初始化进度不得路由给 B 的 sink。
    emitLoggerProgress(0.3)
    // 同语言 C 复用 B 登记中的创建并同步接管进度；旧 A 仍在初始化（句柄未回）。
    const sinkC = vi.fn()
    const acquireC = ocrWorkerModule.acquireOcrWorker('eng', sinkC)
    emitLoggerProgress(0.6)
    // B 也离页（C 保持登记）；随后 A 的句柄才晚到。
    const terminateB = ocrWorkerModule.terminateOcrWorker()
    const oldWorker = makeWorker()
    pendingCreations.shift()!.resolve(oldWorker)
    await terminateA
    await settleAcquire(acquireA)
    await tick()
    // B/C 共享的创建（若有）只能在旧终止完成后开始；允许零创建，若有则必须被清理。
    const gateB = pendingCreations.shift()
    let workerB: FakeWorker | null = null
    if (gateB) {
      workerB = makeWorker()
      gateB.resolve(workerB)
    }
    await terminateB
    await settleAcquire(acquireB)
    await settleAcquire(acquireC)
    expect(oldWorker.terminate).toHaveBeenCalledTimes(1)
    if (workerB) expect(workerB.terminate).toHaveBeenCalledTimes(1)
    // sink 断言放末尾：红失败不留未决 gate 挂死后续用例的复位 fixture。
    expect(sinkB).not.toHaveBeenCalled()
    expect(sinkC).not.toHaveBeenCalled()
  })

  it('已过归属的迟来释放不清新归属的进度 sink', async () => {
    const first = await createAcquire(ocrWorkerModule, 'eng', vi.fn())
    const secondSink = vi.fn()
    const second = await reuseAcquire(ocrWorkerModule, 'eng', secondSink)
    releaseAcquired(ocrWorkerModule, first.acquired)
    emitLoggerProgress(0.5)
    expect(secondSink).toHaveBeenCalledTimes(1)
    expect(workerOf(second)).toBe(first.worker)
  })

  it('已过归属的迟来释放不得让新活跃 worker 被空闲计时终止', async () => {
    const first = await createAcquire(ocrWorkerModule, 'eng', vi.fn())
    await reuseAcquire(ocrWorkerModule, 'eng', vi.fn())
    vi.useFakeTimers()
    releaseAcquired(ocrWorkerModule, first.acquired)
    await vi.advanceTimersByTimeAsync(ocrWorkerModule.OCR_IDLE_TERMINATE_MS)
    expect(first.worker.terminate).not.toHaveBeenCalled()
  })

  it('正常完成后同语言再识别复用同一 worker', async () => {
    const first = await createAcquire(ocrWorkerModule, 'eng', vi.fn())
    releaseAcquired(ocrWorkerModule, first.acquired)
    const second = await reuseAcquire(ocrWorkerModule, 'eng', vi.fn())
    expect(mocks.createWorker).toHaveBeenCalledTimes(1)
    expect(workerOf(second)).toBe(first.worker)
  })

  it('释放后固定 5 分钟空闲终止，且不满时长不终止', async () => {
    const first = await createAcquire(ocrWorkerModule, 'eng', vi.fn())
    vi.useFakeTimers()
    releaseAcquired(ocrWorkerModule, first.acquired)
    await vi.advanceTimersByTimeAsync(ocrWorkerModule.OCR_IDLE_TERMINATE_MS - 1)
    expect(first.worker.terminate).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(first.worker.terminate).toHaveBeenCalledTimes(1)
  })

  it('语言切换：先终止旧 worker 再创建新语言 worker，新进度路由给新 sink', async () => {
    const first = await createAcquire(ocrWorkerModule, 'eng', vi.fn())
    const newSink = vi.fn()
    const secondPending = ocrWorkerModule.acquireOcrWorker('chi_sim+eng', newSink)
    await tick()
    expect(first.worker.terminate).toHaveBeenCalledTimes(1)
    expect(mocks.createWorker).toHaveBeenLastCalledWith('chi_sim+eng', 1, expect.anything())
    const nextWorker = makeWorker()
    pendingCreations.shift()!.resolve(nextWorker)
    const acquired = await secondPending
    expect(workerOf(acquired)).toBe(nextWorker)
    emitLoggerProgress(0.7)
    expect(newSink).toHaveBeenCalledTimes(1)
  })

  it('createWorker 已在途时取消：句柄可用后实际终止', async () => {
    const acquirePending = ocrWorkerModule.acquireOcrWorker('eng', vi.fn())
    await tick()
    const cancelPending = ocrWorkerModule.terminateOcrWorker()
    const pendingWorker = makeWorker()
    pendingCreations.shift()!.resolve(pendingWorker)
    await cancelPending
    expect(pendingWorker.terminate).toHaveBeenCalledTimes(1)
    await acquirePending
  })

  it('createWorker 启动失败：acquire 以该原因拒绝、单例复位，再次 acquire 重新创建并成功', async () => {
    const sink = vi.fn()
    const failing = ocrWorkerModule.acquireOcrWorker('eng', sink)
    await tick()
    expect(mocks.createWorker).toHaveBeenCalledTimes(1)
    // wrapper 必须给 SDK 传 errorHandler：作业拒绝只经 Promise 上报，SDK 不再默认 throw 到 window；
    // 它本身不得抛错，也不触碰进度 sink。
    const options = mocks.createWorker.mock.calls[0]?.[2] as { errorHandler?: (error: unknown) => void }
    expect(typeof options.errorHandler).toBe('function')
    expect(() => options.errorHandler!('synthetic job failure')).not.toThrow()
    expect(sink).not.toHaveBeenCalled()
    pendingCreations.shift()!.reject(new Error('synthetic initialize failure'))
    await expect(failing).rejects.toThrow('synthetic initialize failure')
    const retry = ocrWorkerModule.acquireOcrWorker('eng', vi.fn())
    await tick()
    expect(mocks.createWorker).toHaveBeenCalledTimes(2)
    const recovered = makeWorker()
    pendingCreations.shift()!.resolve(recovered)
    expect(workerOf(await retry)).toBe(recovered)
  })

  it('在途创建失败期间 terminate：终止不悬挂并正常完成，之后 acquire 恢复创建', async () => {
    const failing = ocrWorkerModule.acquireOcrWorker('eng', vi.fn())
    await tick()
    const cancelPending = ocrWorkerModule.terminateOcrWorker()
    pendingCreations.shift()!.reject(new Error('synthetic loadLanguage failure'))
    // 未打补丁的 SDK 会让创建永久 pending，等待它的 terminate 也永不完成；
    // 创建一经拒绝，terminate 必须在下一个宏任务前结束。
    await expect(
      Promise.race([cancelPending.then(() => 'terminated'), tick().then(() => 'hung')]),
    ).resolves.toBe('terminated')
    await settleAcquire(failing)
    const retry = ocrWorkerModule.acquireOcrWorker('eng', vi.fn())
    await tick()
    expect(mocks.createWorker).toHaveBeenCalledTimes(2)
    const recovered = makeWorker()
    pendingCreations.shift()!.resolve(recovered)
    expect(workerOf(await retry)).toBe(recovered)
  })
})
