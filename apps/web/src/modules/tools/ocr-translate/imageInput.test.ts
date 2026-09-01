import { describe, expect, it, vi, afterEach } from 'vitest'

import {
  IMAGE_LIMITS,
  computeResizeDimensions,
  imageTypeLabel,
  probeImageFile,
  resolveImageType,
  validateImageDimensions,
  validateImageMeta,
} from './imageInput'

const PNG = 'image/png'
const JPEG = 'image/jpeg'
const WEBP = 'image/webp'

describe('validateImageMeta（类型与大小）', () => {
  it('接受 PNG/JPEG/WebP（MIME 优先、扩展名兜底）', () => {
    expect(validateImageMeta('a.png', PNG, 100)).toBeNull()
    expect(validateImageMeta('a.jpg', JPEG, 100)).toBeNull()
    expect(validateImageMeta('a.jpeg', '', 100)).toBeNull()
    expect(validateImageMeta('a.webp', '', 100)).toBeNull()
    expect(resolveImageType('a.PNG', '')).toBe(PNG)
    expect(imageTypeLabel(JPEG)).toBe('JPEG')
  })

  it('拒绝不支持的格式（PDF/HEIC/TIFF/未知扩展名）', () => {
    expect(validateImageMeta('a.pdf', 'application/pdf', 100)?.code).toBe('TYPE_UNSUPPORTED')
    expect(validateImageMeta('a.heic', '', 100)?.code).toBe('TYPE_UNSUPPORTED')
    expect(validateImageMeta('a.tiff', '', 100)?.code).toBe('TYPE_UNSUPPORTED')
    expect(validateImageMeta('a.txt', 'text/plain', 100)?.code).toBe('TYPE_UNSUPPORTED')
  })

  it('拒绝超过 5 MiB 的图片', () => {
    expect(validateImageMeta('a.png', PNG, IMAGE_LIMITS.maxBytes + 1)?.code).toBe('FILE_TOO_LARGE')
    expect(validateImageMeta('a.png', PNG, IMAGE_LIMITS.maxBytes)).toBeNull()
  })
})

describe('validateImageDimensions（宽高与比例）', () => {
  it('宽或高必须大于 15 px', () => {
    expect(validateImageDimensions(15, 100)?.code).toBe('DIMENSION_TOO_SMALL')
    expect(validateImageDimensions(100, 15)?.code).toBe('DIMENSION_TOO_SMALL')
    expect(validateImageDimensions(16, 100)).toBeNull()
    expect(validateImageDimensions(NaN, 100)?.code).toBe('DIMENSION_TOO_SMALL')
  })

  it('长边/短边必须小于 50', () => {
    // 比例用例需同时满足“宽高都大于 15 px”，否则先命中过小校验
    expect(validateImageDimensions(1000, 20)?.code).toBe('ASPECT_RATIO_TOO_EXTREME')
    expect(validateImageDimensions(20, 1000)?.code).toBe('ASPECT_RATIO_TOO_EXTREME')
    // 边界：49.9x 允许，50x 拒绝
    expect(validateImageDimensions(1000, 21)).toBeNull()
    expect(validateImageDimensions(1000, 20)?.code).toBe('ASPECT_RATIO_TOO_EXTREME')
  })
})

describe('computeResizeDimensions（>4096 等比缩小）', () => {
  it('最长边不超过 4096 时不需要缩放', () => {
    expect(computeResizeDimensions(4096, 100)).toBeNull()
    expect(computeResizeDimensions(100, 4096)).toBeNull()
  })

  it('超过 4096 时按比例缩小且最长边恰好 4096', () => {
    const result = computeResizeDimensions(8192, 4096)
    expect(result).toEqual({ width: 4096, height: 2048 })
    const vertical = computeResizeDimensions(3000, 9000)
    expect(vertical).toEqual({ width: 1365, height: 4096 })
  })
})

describe('probeImageFile（浏览器管线，jsdom 用 stub）', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  function stubDecode(originalWidth: number, originalHeight: number, resizedBytes = 6) {
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({
      width: originalWidth,
      height: originalHeight,
      close: vi.fn(),
    })))
    document.createElement = vi.fn((tag: string) => {
      if (tag === 'canvas') {
        const canvas = {
          width: 0,
          height: 0,
          getContext: () => ({
            drawImage: vi.fn(),
          }),
          toBlob: (callback: (blob: Blob | null) => void) => {
            callback(new Blob([new Uint8Array(resizedBytes)], { type: 'image/png' }))
          },
        }
        return canvas as unknown as HTMLCanvasElement
      }
      return new (class extends HTMLElement {})()
    })
  }

  it('合法小图直接通过，不调整', async () => {
    stubDecode(800, 600)
    const file = new File(['x'], 'photo.png', { type: PNG })
    const result = await probeImageFile(file)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.image.adjusted).toBe(false)
      expect(result.image.width).toBe(800)
      expect(result.image.typeLabel).toBe('PNG')
    }
  })

  it('超过 4096 px 时本地等比缩小并重编码', async () => {
    stubDecode(9000, 3000)
    const file = new File(['x'], 'large.webp', { type: WEBP })
    const result = await probeImageFile(file)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.image.adjusted).toBe(true)
      expect(result.image.width).toBe(4096)
      expect(result.image.height).toBe(1365)
      expect(result.image.blob.size).toBeGreaterThan(0)
    }
  })

  it('缩放后 PNG 仍超过 5 MiB 时拒绝，不把超限文件交给 OCR', async () => {
    stubDecode(9000, 3000, IMAGE_LIMITS.maxBytes + 1)
    const file = new File(['x'], 'large.webp', { type: WEBP })
    const result = await probeImageFile(file)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.violation.code).toBe('FILE_TOO_LARGE')
  })

  it('类型不支持时在解码前拒绝', async () => {
    stubDecode(800, 600)
    const file = new File(['x'], 'doc.pdf', { type: 'application/pdf' })
    const result = await probeImageFile(file)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.violation.code).toBe('TYPE_UNSUPPORTED')
  })

  it('解码后宽高非法时拒绝', async () => {
    stubDecode(10, 5000)
    const file = new File(['x'], 'tiny.png', { type: PNG })
    const result = await probeImageFile(file)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.violation.code).toBe('DIMENSION_TOO_SMALL')
  })
})
