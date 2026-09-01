/**
 * Tesseract 单例 worker 管理（docs/09 §9.2、docs/10 §3.5）。
 *
 * - 模块级单例：同一时刻最多一个 OCR worker；语言变化时先终止再重建。
 * - worker/core/语言数据固定来自本站 /tesseract/* 静态资产，禁止任何 CDN 外链。
 * - tesseract.js 只通过动态 import 加载，保持在 OCR 路由 chunk 内。
 * - 取消/路由卸载立即 terminate；识别结束进入 5 分钟空闲复用窗口，到期自动
 *   terminate，下次需要时重建。
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

let workerPromise: Promise<TesseractWorker> | null = null
let workerLang: OcrLanguagePreset | null = null
let progressSink: OcrProgressSink | null = null
let idleTimer: number | undefined

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

/**
 * 获取（或复用）当前语言的 worker。并发调用复用同一个创建中的 Promise，
 * 保证同一时刻最多一个 worker；复用时会取消空闲终止计时。
 */
export async function acquireOcrWorker(
  lang: OcrLanguagePreset,
  onProgress?: OcrProgressSink,
): Promise<TesseractWorker> {
  progressSink = onProgress ?? null
  if (workerPromise && workerLang === lang) {
    clearIdleTimer()
    return workerPromise
  }
  if (workerPromise) {
    // 语言切换：先终止旧 worker，同一时刻仍只有一个实例。
    await terminateOcrWorker()
  }
  const { createWorker } = await import('tesseract.js')
  workerLang = lang
  workerPromise = createWorker(lang, 1 /* OEM.LSTM_ONLY，与 core 的 lstm 资产匹配 */, {
    ...TESSERACT_ASSET_PATHS,
    logger: handleLoggerMessage,
  })
  try {
    return await workerPromise
  } catch (error) {
    workerPromise = null
    workerLang = null
    throw error
  }
}

/** 一次识别结束：进入短时复用窗口，5 分钟空闲后自动 terminate。 */
export function releaseOcrWorker(): void {
  progressSink = null
  scheduleIdleTermination()
}

/** 立即终止并丢弃 worker（取消、路由卸载、语言切换前）。 */
export async function terminateOcrWorker(): Promise<void> {
  clearIdleTimer()
  progressSink = null
  const pending = workerPromise
  workerPromise = null
  workerLang = null
  if (!pending) return
  try {
    const worker = await pending
    await worker.terminate()
  } catch {
    // 终止失败只能丢弃引用；等待浏览器回收该 worker。
  }
}
