/**
 * @vitest-environment node
 *
 * tesseract.js@7.0.0 启动失败与运行期 worker 死亡回归（patches/tesseract.js@7.0.0.patch，
 * docs/10 §3.5）。
 *
 * 直接编译 apps/web 实际解析到的已安装 SDK 源码 src/createWorker.js——Vite 浏览器
 * 构建同样走这份源码（package.json browser 字段只把 ./worker/node 换成浏览器适配器）。
 * 仅把 worker I/O 适配器替换为同步计数的假实现：不起真实 worker 线程、不访问网络、
 * 不 mock createWorker 的返回值。覆盖 load / loadLanguage / initialize 作业拒绝与
 * worker onerror 四类启动失败：createWorker 必须拒绝而不是永久 pending；物理 worker
 * 在拒绝被观察到之前已恰好终止一次，下一次创建开始前活跃实例归零。随后一次成功
 * 创建可识别并正常终止。运行期场景覆盖 ready 后 recognize 在途触发 worker onerror：
 * 在途识别 Promise 必须以该错误拒绝（不永久悬挂），物理终止先于拒绝被观察且恰好
 * 一次，死亡句柄再 terminate 不二次终止，新建 worker 可正常识别。
 *
 * 用 .mjs 而非 .ts：tsconfig.app.json 只带 vitest/globals 类型且不为此修改，
 * 而本测试需要 node:fs / node:vm / node:module 直接编译安装包源码。
 */
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const appRequire = createRequire(import.meta.url)
const sdkPath = appRequire.resolve('tesseract.js/src/createWorker.js')
const sdkRequire = createRequire(sdkPath)
const realNodeAdapter = sdkRequire('./worker/node')

/** 当前场景的 I/O 记录；spawnWorker 把它绑定到新建的假物理 worker 上。 */
let current = null
/** 当前存活的假物理 worker 数：spawnWorker +1，terminateWorker -1。 */
let active = 0
const contexts = new WeakMap()

const fakeAdapter = {
  ...realNodeAdapter,
  spawnWorker: () => {
    const worker = {}
    contexts.set(worker, current)
    current.activeBeforeSpawn = active
    current.spawned += 1
    active += 1
    return worker
  },
  terminateWorker: (worker) => {
    contexts.get(worker).terminated += 1
    active -= 1
  },
  onMessage: (worker, receive) => {
    contexts.get(worker).receive = receive
  },
  send: (worker, request) => {
    const ctx = contexts.get(worker)
    ctx.actions.push(request.action)
    queueMicrotask(() => {
      if (ctx.failStage === 'worker-error' && request.action === 'load') {
        worker.onerror({ message: 'synthetic script failure' })
        return
      }
      if (ctx.runtimeWorkerError && request.action === 'recognize') {
        worker.onerror({ message: 'synthetic runtime failure' })
        return
      }
      const failed = request.action === ctx.failStage
      ctx.receive({
        workerId: request.workerId,
        jobId: request.jobId,
        action: request.action,
        status: failed ? 'reject' : 'resolve',
        data: failed
          ? `synthetic ${request.action} failure`
          : request.action === 'recognize'
            ? { text: 'synthetic text' }
            : {},
      })
    })
  },
  loadImage: async (image) => image,
}

// 用 SDK 自带的 Node CJS 包装签名编译真实源码；只有 './worker/node' 换成假适配器。
const compiled = vm.compileFunction(
  fs.readFileSync(sdkPath, 'utf8'),
  ['exports', 'require', 'module', '__filename', '__dirname'],
  { filename: sdkPath },
)
const moduleShim = { exports: {} }
compiled(
  moduleShim.exports,
  (id) => (id === './worker/node' ? fakeAdapter : sdkRequire(id)),
  moduleShim,
  sdkPath,
  path.dirname(sdkPath),
)
const createWorker = moduleShim.exports

function startScenario(failStage, runtimeWorkerError = false) {
  current = {
    failStage,
    runtimeWorkerError,
    actions: [],
    spawned: 0,
    terminated: 0,
    activeBeforeSpawn: -1,
    errors: [],
    receive: null,
  }
  return current
}

/**
 * 启动结果：拒绝/解决都应在一个定时器周期内发生；返回 pending 即为审计描述的
 * 永久悬挂（未打补丁 SDK 的症状）。terminatedWhenRejected 断言物理终止发生在
 * 拒绝被观察之前。
 */
async function settleStartup(creation, ctx) {
  let timer
  const pendingGuard = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ state: 'pending' }), 50)
  })
  const result = await Promise.race([
    creation.then(
      (worker) => ({ state: 'resolved', worker }),
      (error) => ({
        state: 'rejected',
        error,
        terminatedWhenRejected: ctx.terminated,
        activeWhenRejected: active,
      }),
    ),
    pendingGuard,
  ])
  clearTimeout(timer)
  return result
}

/** 识别结果：拒绝/解决都应在一个定时器周期内发生；pending 即为运行期悬挂症状。 */
async function settleRecognize(recognition, ctx) {
  let timer
  const pendingGuard = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ state: 'pending' }), 50)
  })
  const result = await Promise.race([
    recognition.then(
      (value) => ({ state: 'resolved', value }),
      (error) => ({
        state: 'rejected',
        error,
        terminatedWhenRejected: ctx.terminated,
        activeWhenRejected: active,
      }),
    ),
    pendingGuard,
  ])
  clearTimeout(timer)
  return result
}

describe('tesseract.js@7.0.0 已打补丁的 createWorker 启动链', () => {
  it.each([
    ['load', ['load']],
    ['loadLanguage', ['load', 'loadLanguage']],
    ['initialize', ['load', 'loadLanguage', 'initialize']],
    ['worker-error', ['load']],
  ])('%s 阶段失败：创建被拒绝，物理 worker 恰好终止一次', async (failStage, expectedActions) => {
    expect(active).toBe(0)
    const ctx = startScenario(failStage)
    const creation = createWorker('eng', 1, {
      logger: () => {},
      errorHandler: (error) => ctx.errors.push(String(error)),
    })
    const result = await settleStartup(creation, ctx)
    expect(result.state).toBe('rejected')
    expect(String(result.error)).toBe(
      failStage === 'worker-error' ? 'synthetic script failure' : `synthetic ${failStage} failure`,
    )
    expect(result.terminatedWhenRejected).toBe(1)
    expect(result.activeWhenRejected).toBe(0)
    expect(ctx.activeBeforeSpawn).toBe(0)
    expect(ctx.spawned).toBe(1)
    expect(ctx.terminated).toBe(1)
    expect(ctx.actions).toEqual(expectedActions)
    // 作业拒绝阶段 errorHandler 被调用一次；onerror 路径不走 errorHandler。
    expect(ctx.errors).toEqual(failStage === 'worker-error' ? [] : [`synthetic ${failStage} failure`])
  })

  it('失败后紧接着一次成功创建：可识别并正常终止，不残留物理 worker', async () => {
    expect(active).toBe(0)
    const ctx = startScenario('success')
    const creation = createWorker('eng', 1, {
      logger: () => {},
      errorHandler: (error) => ctx.errors.push(String(error)),
    })
    const result = await settleStartup(creation, ctx)
    expect(result.state).toBe('resolved')
    const { data } = await result.worker.recognize('synthetic-image')
    expect(data.text).toBe('synthetic text')
    expect(ctx.actions).toEqual(['load', 'loadLanguage', 'initialize', 'recognize'])
    expect(ctx.terminated).toBe(0)
    await result.worker.terminate()
    expect(ctx.terminated).toBe(1)
    expect(active).toBe(0)
    expect(ctx.errors).toEqual([])
  })

  it('ready 后 recognize 在途 worker onerror：在途识别以该错误拒绝，物理终止先于拒绝恰好一次，新建 worker 可识别', async () => {
    expect(active).toBe(0)
    const ctx = startScenario(null, true)
    const creation = createWorker('eng', 1, {
      logger: () => {},
      errorHandler: (error) => ctx.errors.push(String(error)),
    })
    const result = await settleStartup(creation, ctx)
    expect(result.state).toBe('resolved')

    // workerRes 已解决，workerResReject 不再是渠道；悬挂与否只看识别 Promise。
    const settled = await settleRecognize(result.worker.recognize('synthetic-image'), ctx)
    expect(settled.state).toBe('rejected')
    expect(String(settled.error)).toBe('synthetic runtime failure')
    // 物理终止发生在拒绝被观察之前，且恰好一次、活跃实例归零。
    expect(settled.terminatedWhenRejected).toBe(1)
    expect(settled.activeWhenRejected).toBe(0)
    expect(ctx.actions).toEqual(['load', 'loadLanguage', 'initialize', 'recognize'])
    // onerror 路径不经过 errorHandler：作业拒绝只经由对应 Promise 上报。
    expect(ctx.errors).toEqual([])
    // 死亡句柄再 terminate 不得二次终止物理实例。
    await result.worker.terminate()
    expect(ctx.terminated).toBe(1)
    expect(active).toBe(0)

    // 死亡后新建 worker：可识别并正常终止，不残留物理实例。
    const recovery = startScenario('success')
    const recoveredCreation = createWorker('eng', 1, {
      logger: () => {},
      errorHandler: (error) => recovery.errors.push(String(error)),
    })
    const recovered = await settleStartup(recoveredCreation, recovery)
    expect(recovered.state).toBe('resolved')
    const { data } = await recovered.worker.recognize('synthetic-image')
    expect(data.text).toBe('synthetic text')
    await recovered.worker.terminate()
    expect(recovery.terminated).toBe(1)
    expect(active).toBe(0)
    expect(recovery.errors).toEqual([])
  })
})
