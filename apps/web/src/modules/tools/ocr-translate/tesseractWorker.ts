/**
 * Tesseract 单例 worker 管理（docs/09 §9.2、docs/10 §3.5）。
 *
 * - 模块级单例：同一时刻最多一个 OCR worker；语言变化时先终止再重建，
 *   新建必须等旧 worker 真正终止完成后才开始。
 * - worker/core/语言数据固定来自本站 /tesseract/* 静态资产，禁止任何 CDN 外链。
 * - tesseract.js 只通过动态 import 加载，保持在 OCR 路由 chunk 内；import、
 *   createWorker 与登记前的旧终止等待都放进同一个创建 Promise，并在 acquire
 *   当帧登记，登记之前没有 await 窗口：冷加载等待期内的取消/离页/并发复用
 *   都能被登记的 Promise 覆盖，晚到的句柄会被真正终止。
 * - acquire 返回归属句柄（lease）：识别结束由当前归属 release 进入 5 分钟空闲
 *   复用窗口，到期自动 terminate；归属已被 terminate 或新 acquire 移交时
 *   release 为 no-op，迟来的释放不影响新归属的进度与空闲计时。新归属的进度
 *   sink 在旧 worker 清理完成后才接管；worker 的 logger 只转发当前登记创建
 *   的事件，旧物理实例的进度不再读取全局 sink。
 * - tesseract.js 要等初始化（下载 core/语言数据）完成才返回带 terminate 的
 *   句柄；此前的取消只能在句柄可用后立即终止，无法提前物理杀死。
 * - tesseract.js@7.0.0 经 patches/tesseract.js@7.0.0.patch 修正启动与运行期失败：
 *   load/loadLanguage/initialize 作业拒绝或 worker onerror 时先同步终止物理
 *   worker 再拒绝 createWorker；ready 后 worker onerror 也会终止物理实例并拒绝
 *   全部在途作业（recognize 以该错误拒绝，不再永久 pending）。这里传入
 *   errorHandler，作业拒绝只经由对应 Promise（acquire/recognize 的既有错误渠道）
 *   上报，SDK 不再把同一错误 throw 到 window。本模块不感知 worker 运行期死亡，
 *   失败后丢弃缓存由消费者完成（OcrTranslateView.runLocalOcr）。
 */

import type { LoggerMessage, Worker as TesseractWorker } from 'tesseract.js'

/** 本站静态资产路径（apps/web/public/tesseract，来源见其 PROVENANCE.md）。 */
export const TESSERACT_ASSET_PATHS = {
  workerPath: '/tesseract/worker.min.js',
  corePath: '/tesseract/core',
  langPath: '/tesseract/lang',
} as const

export const OCR_IDLE_TERMINATE_MS = 5 * 60 * 1000

export type OcrLanguagePreset = 'chi_sim+eng' | 'eng'

export interface OcrProgressUpdate {
  /** loading=下载/加载模型与初始化；recognizing=识别中。 */
  stage: 'loading' | 'recognizing'
  progress: number
  status: string
}

export type OcrProgressSink = (update: OcrProgressUpdate) => void

/** acquire 返回的归属句柄：release 只在本次归属仍有效时生效。 */
export interface OcrWorkerLease {
  readonly worker: TesseractWorker
  /** 当前归属的识别结束：进入 5 分钟空闲复用窗口；归属已移交或已终止时为 no-op。 */
  release: () => void
}

let workerPromise: Promise<TesseractWorker> | null = null
let workerLang: OcrLanguagePreset | null = null
let progressSink: OcrProgressSink | null = null
let idleTimer: number | undefined
/** 进行中的终止：后续 acquire 必须等它完成后才能创建新 worker。 */
let terminating: Promise<void> | null = null
/** 归属代次：acquire 取得归属、terminate 作废全部归属时递增。 */
let leaseEpoch = 0

function clearIdleTimer(): void {
  if (idleTimer !== undefined) {
    window.clearTimeout(idleTimer)
    idleTimer = undefined
  }
}

function scheduleIdleTermination(): void {
  clearIdleTimer()
  idleTimer = window.setTimeout(() => {
    void terminateOcrWorker()
  }, OCR_IDLE_TERMINATE_MS)
}

function handleLoggerMessage(message: LoggerMessage): void {
  progressSink?.({
    stage: message.status === 'recognizing text' ? 'recognizing' : 'loading',
    progress: typeof message.progress === 'number' ? message.progress : 0,
    status: message.status,
  })
}

function makeLease(epoch: number, worker: TesseractWorker): OcrWorkerLease {
  return {
    worker,
    release: () => {
      if (epoch !== leaseEpoch) return
      progressSink = null
      scheduleIdleTermination()
    },
  }
}

/**
 * 等旧终止完成、旧语言 worker 句柄可用后终止它，再动态 import 并创建新
 * worker。sink 只在旧清理完成后、且本次归属仍是最新代次时接管：后续 acquire
 * 已同步接管 sink 的情况下，旧的创建续体不得把 sink 回写为自己的。logger
 * 转发前核对本次创建仍是当前登记资源，旧物理实例的事件不读新归属的 sink。
 * 捕获的 prior/obsolete 都是登记前已存在的 Promise，不会自等待。
 */
async function createAfter(
  prior: Promise<void> | null,
  obsolete: Promise<TesseractWorker> | null,
  sink: OcrProgressSink | null,
  lang: OcrLanguagePreset,
  epoch: number,
  isCurrentCreation: () => boolean,
): Promise<TesseractWorker> {
  await prior
  if (obsolete) {
    try {
      const worker = await obsolete
      await worker.terminate()
    } catch {
      // 终止失败只能丢弃引用；等待浏览器回收该 worker。
    }
  }
  if (epoch === leaseEpoch) progressSink = sink
  const { createWorker } = await import('tesseract.js')
  return createWorker(lang, 1 /* OEM.LSTM_ONLY，与 core 的 lstm 资产匹配 */, {
    ...TESSERACT_ASSET_PATHS,
    logger: (message) => {
      if (isCurrentCreation()) handleLoggerMessage(message)
    },
    // 同一错误已 reject 对应的 createWorker/recognize Promise；提供 errorHandler 只为
    // 阻止 SDK 默认把它再 throw 到 window.onerror。
    errorHandler: () => {},
  })
}

/**
 * 获取（或复用）当前语言的 worker。并发调用复用同一个创建中的 Promise，
 * 保证同一时刻最多一个 worker；复用时会取消空闲终止计时。归属移交给最新
 * 的 acquire，早先调用方迟来的 release 不会影响新归属。
 */
export async function acquireOcrWorker(
  lang: OcrLanguagePreset,
  onProgress?: OcrProgressSink,
): Promise<OcrWorkerLease> {
  const prior = terminating
  if (workerPromise && workerLang === lang) {
    const epoch = (leaseEpoch += 1)
    clearIdleTimer()
    progressSink = onProgress ?? null
    return workerPromise.then((worker) => makeLease(epoch, worker))
  }
  // 新语言/新创建当帧登记：旧终止等待与旧 worker 清理都在创建 Promise 内部，
  // 任何时刻的 terminate 都能经由 workerPromise 捕获到这次创建。
  clearIdleTimer()
  const epoch = (leaseEpoch += 1)
  const creation: Promise<TesseractWorker> = createAfter(
    prior,
    workerPromise,
    onProgress ?? null,
    lang,
    epoch,
    () => workerPromise === creation,
  )
  workerLang = lang
  workerPromise = creation
  try {
    return makeLease(epoch, await creation)
  } catch (error) {
    if (workerPromise === creation) {
      workerPromise = null
      workerLang = null
    }
    throw error
  }
}

/**
 * 立即终止并丢弃 worker（取消、路由卸载、语言切换前）；已发出的归属 release
 * 全部失效。登记中的创建会等到句柄可用后立即 terminate。
 */
export async function terminateOcrWorker(): Promise<void> {
  clearIdleTimer()
  progressSink = null
  leaseEpoch += 1
  const pending = workerPromise
  workerPromise = null
  workerLang = null
  const prior = terminating
  const done = (async () => {
    await prior
    if (!pending) return
    try {
      const worker = await pending
      await worker.terminate()
    } catch {
      // 终止失败只能丢弃引用；等待浏览器回收该 worker。
    }
  })()
  terminating = done
  try {
    await done
  } finally {
    if (terminating === done) terminating = null
  }
}
