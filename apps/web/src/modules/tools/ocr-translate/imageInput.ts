/**
 * OCR 图片输入校验与本地调整（docs/09 §9.1、docs/12 §8）。
 *
 * 纯函数部分（类型/大小/宽高/比例矩阵、>4096 等比缩放计算）可单测；
 * 浏览器部分（解码尺寸、canvas 缩放）只做无状态转换，不落任何存储。
 * 过小或过于狭长的图片直接拒绝，不放大、不裁切、不补边。
 */

export const IMAGE_ACCEPT = 'image/png,image/jpeg,image/webp'

export const IMAGE_LIMITS = {
  /** 5 MiB 产品上限（docs/09 §6.4）。 */
  maxBytes: 5 * 1024 * 1024,
  /** 宽与高都必须大于 15 px。 */
  minDimension: 15,
  /** 最长边超过该值时浏览器本地等比缩小。 */
  maxLongEdge: 4096,
  /** 长边 / 短边必须小于该值。 */
  maxAspectRatio: 50,
} as const

export type ImageViolationCode =
  | 'TYPE_UNSUPPORTED'
  | 'FILE_TOO_LARGE'
  | 'DIMENSION_TOO_SMALL'
  | 'ASPECT_RATIO_TOO_EXTREME'

export interface ImageViolation {
  code: ImageViolationCode
  message: string
}

export type ImageTypeLabel = 'PNG' | 'JPEG' | 'WebP'

export interface LoadedImage {
  fileName: string
  /** 原始文件的展示类型；调整后重新编码的 blob 以自身类型上传。 */
  typeLabel: ImageTypeLabel
  /** 本地识别与云端上传共用的当前图片字节（可能已等比缩小）。 */
  blob: Blob
  /** 调整后大小（未调整时等于原始大小）。 */
  sizeBytes: number
  originalSizeBytes: number
  /** 调整后尺寸。 */
  width: number
  height: number
  originalWidth: number
  originalHeight: number
  adjusted: boolean
}

export type ImageProbeResult =
  | { ok: true; image: LoadedImage }
  | { ok: false; violation: ImageViolation }

const EXTENSION_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
}

const MIME_LABELS: Record<string, ImageTypeLabel> = {
  'image/png': 'PNG',
  'image/jpeg': 'JPEG',
  'image/webp': 'WebP',
}

/** 以 MIME 优先、扩展名兜底解析出受支持的图片类型；解析不出返回 null。 */
export function resolveImageType(fileName: string, mimeType: string): string | null {
  const normalized = mimeType.trim().toLowerCase()
  if (normalized in MIME_LABELS) return normalized
  const extension = fileName.toLowerCase().split('.').at(-1) ?? ''
  return EXTENSION_TYPES[extension] ?? null
}

export function imageTypeLabel(mimeType: string): ImageTypeLabel {
  return MIME_LABELS[mimeType] ?? 'PNG'
}

export function formatImageBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
  return `${Math.max(1, Math.round(bytes / 1024))} KiB`
}

/** 类型与大小校验（纯函数）。 */
export function validateImageMeta(fileName: string, mimeType: string, size: number): ImageViolation | null {
  const resolved = resolveImageType(fileName, mimeType)
  if (!resolved) {
    return {
      code: 'TYPE_UNSUPPORTED',
      message: '仅支持单张 PNG、JPEG 或 WebP 图片；不支持 PDF、HEIC、TIFF、批量文件或相机实时输入。',
    }
  }
  if (size > IMAGE_LIMITS.maxBytes) {
    return {
      code: 'FILE_TOO_LARGE',
      message: `图片 ${formatImageBytes(size)} 超过 ${formatImageBytes(IMAGE_LIMITS.maxBytes)} 上限；请先压缩再试。`,
    }
  }
  return null
}

/** 宽高与长宽比校验（纯函数）；不满足直接拒绝，不自动放大、裁切或补边。 */
export function validateImageDimensions(width: number, height: number): ImageViolation | null {
  if (!Number.isFinite(width) || !Number.isFinite(height)) {
    return {
      code: 'DIMENSION_TOO_SMALL',
      message: '无法读取图片尺寸；请更换一张 PNG、JPEG 或 WebP 图片。',
    }
  }
  if (width <= IMAGE_LIMITS.minDimension || height <= IMAGE_LIMITS.minDimension) {
    return {
      code: 'DIMENSION_TOO_SMALL',
      message: `图片宽和高都必须大于 ${IMAGE_LIMITS.minDimension} px（当前 ${width} × ${height}）；过小的图片会被直接拒绝，不会自动放大、裁切或补边。`,
    }
  }
  const ratio = Math.max(width, height) / Math.min(width, height)
  if (ratio >= IMAGE_LIMITS.maxAspectRatio) {
    return {
      code: 'ASPECT_RATIO_TOO_EXTREME',
      message: `长边与短边之比 ${ratio.toFixed(1)} 不小于 ${IMAGE_LIMITS.maxAspectRatio}；过于狭长的图片无法可靠识别，请更换图片。`,
    }
  }
  return null
}

/**
 * >4096 px 的等比缩小目标尺寸（纯函数）；最长边不超过 4096 且比例保持不变。
 * 不需要缩放时返回 null。
 */
export function computeResizeDimensions(
  width: number,
  height: number,
): { width: number; height: number } | null {
  const longEdge = Math.max(width, height)
  if (longEdge <= IMAGE_LIMITS.maxLongEdge) return null
  // 比例校验已在前：short > long/50 > 81 px，floor 后仍远大于 15 px。
  const scale = IMAGE_LIMITS.maxLongEdge / longEdge
  return {
    width: Math.floor(width * scale),
    height: Math.floor(height * scale),
  }
}

interface DecodedSource {
  source: CanvasImageSource
  width: number
  height: number
  close: () => void
}

/** 解码图片取尺寸；优先 createImageBitmap，退回 HTMLImageElement。 */
async function decodeSource(blob: Blob): Promise<DecodedSource> {
  if (typeof globalThis.createImageBitmap === 'function') {
    const bitmap = await globalThis.createImageBitmap(blob)
    return {
      source: bitmap,
      width: bitmap.width,
      height: bitmap.height,
      close: () => bitmap.close(),
    }
  }
  const url = URL.createObjectURL(blob)
  try {
    const image = new Image()
    image.src = url
    await image.decode()
    if (!image.naturalWidth || !image.naturalHeight) throw new Error('image decode failed')
    return {
      source: image,
      width: image.naturalWidth,
      height: image.naturalHeight,
      close: () => URL.revokeObjectURL(url),
    }
  } catch (error) {
    URL.revokeObjectURL(url)
    throw error
  }
}

/** 用 canvas 等比缩放并重新编码为 PNG；仅在最长边 >4096 时被调用。 */
async function resizeImageBlob(source: CanvasImageSource, width: number, height: number): Promise<Blob> {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) throw new Error('当前浏览器无法执行图片缩放')
  context.drawImage(source, 0, 0, width, height)
  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob)
      else reject(new Error('图片缩放结果编码失败'))
    }, 'image/png')
  })
}

/**
 * 完整入口校验管线：类型/大小 → 解码尺寸 → 宽高/比例 → 必要时本地等比缩小。
 * 全程只在本页内存中进行，不产生任何网络请求或持久化。
 */
export async function probeImageFile(file: File): Promise<ImageProbeResult> {
  const metaViolation = validateImageMeta(file.name, file.type, file.size)
  if (metaViolation) return { ok: false, violation: metaViolation }

  const decoded = await decodeSource(file)
  try {
    const dimensionViolation = validateImageDimensions(decoded.width, decoded.height)
    if (dimensionViolation) return { ok: false, violation: dimensionViolation }

    const mimeType = resolveImageType(file.name, file.type) ?? file.type
    const target = computeResizeDimensions(decoded.width, decoded.height)
    if (!target) {
      return {
        ok: true,
        image: {
          fileName: file.name,
          typeLabel: imageTypeLabel(mimeType),
          blob: file,
          sizeBytes: file.size,
          originalSizeBytes: file.size,
          width: decoded.width,
          height: decoded.height,
          originalWidth: decoded.width,
          originalHeight: decoded.height,
          adjusted: false,
        },
      }
    }
    const blob = await resizeImageBlob(decoded.source, target.width, target.height)
    if (blob.size > IMAGE_LIMITS.maxBytes) {
      return {
        ok: false,
        violation: {
          code: 'FILE_TOO_LARGE',
          message: `图片缩小后为 ${formatImageBytes(blob.size)}，仍超过 ${formatImageBytes(IMAGE_LIMITS.maxBytes)} 上限；请先压缩再试。`,
        },
      }
    }
    return {
      ok: true,
      image: {
        fileName: file.name,
        typeLabel: imageTypeLabel(mimeType),
        blob,
        sizeBytes: blob.size,
        originalSizeBytes: file.size,
        width: target.width,
        height: target.height,
        originalWidth: decoded.width,
        originalHeight: decoded.height,
        adjusted: true,
      },
    }
  } finally {
    decoded.close()
  }
}
