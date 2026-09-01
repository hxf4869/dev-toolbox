import { describe, expect, it } from 'vitest'

import {
  createRunIdentifier,
  formatPlaceholder,
  PLACEHOLDER_PREFIX,
  protectTechnicalContent,
  restoreTranslatedChunk,
} from './protection'

const RUN_ID = 'A7F3C2'

function protect(source: string, runId = RUN_ID) {
  return protectTechnicalContent(source, runId)
}

function placeholdersOf(result: ReturnType<typeof protect>): string[] {
  return [...result.segmentMap.keys()]
}

/** 模拟上游：保留占位符，翻译自然语言部分。 */
const fakeTranslate = (protectedText: string): string =>
  protectedText.replace(/([\u4e00-\u9fff])/g, '译$1')

/** 模拟上游：占位符原样返回（用于验证逐字 round-trip）。 */
const identity = (protectedText: string): string => protectedText

function restore(result: ReturnType<typeof protect>, translated: string, runId = RUN_ID) {
  return restoreTranslatedChunk({
    sourceChunk: result.text,
    translatedChunk: translated,
    runId,
    segmentMap: result.segmentMap,
  })
}

describe('技术内容保护', () => {
  it.each([
    ['围栏代码块', '说明文字\n```bash\nnpm install\n```\n结尾', '```bash'],
    ['未闭合围栏代码块', '说明文字\n```js\nconst x = 1', '```js'],
    ['内联代码', '运行 `npm run build` 命令', '`npm run build`'],
    ['URL', '访问 https://example.com/docs?a=1 查看', 'https://example.com/docs?a=1'],
    ['URL 尾部标点剥离', '见 https://example.com/docs.', 'https://example.com/docs'],
    ['Windows 路径', '打开 C:\\Users\\me\\notes.txt 文件', 'C:\\Users\\me\\notes.txt'],
    ['Unix 路径', '编辑 /etc/nginx/nginx.conf 配置', '/etc/nginx/nginx.conf'],
    ['家目录路径', '查看 ~/.ssh/config 内容', '~/.ssh/config'],
    ['相对路径', '运行 ./scripts/deploy.sh 脚本', './scripts/deploy.sh'],
    ['命令行提示符', '$ kubectl get pods -A\n之后检查', '$ kubectl get pods -A'],
    ['常见命令行', 'docker compose up -d 之后完成', 'docker compose up -d'],
    ['标题标记', '## 标题内容\n正文', '##'],
    ['列表标记', '- 项目一\n1. 项目二', '-'],
    ['粗体标记', '这是 **重点** 内容', '**'],
  ])('保护并完整还原：%s', (_name, source: string, snippet: string) => {
    const result = protect(source)
    expect(result.segmentMap.size).toBeGreaterThan(0)
    expect([...result.segmentMap.values()].some((value) => value.includes(snippet))).toBe(true)
    // 保护后文本不包含原始技术片段，只保留占位符。
    expect(result.text).not.toContain(snippet)

    const restored = restore(result, identity(result.text))
    expect(restored.ok).toBe(true)
    if (restored.ok) expect(restored.text).toBe(source)
  })

  it('自然语言被翻译，技术片段逐字还原', () => {
    const result = protect('访问 https://example.com/docs 查看')
    const translated = result.text.replace('访问', 'Visit').replace('查看', 'to view')
    const restored = restore(result, translated)
    expect(restored).toMatchObject({ ok: true })
    if (restored.ok) expect(restored.text).toBe('Visit https://example.com/docs to view')
  })

  it('占位符形如 __DT_<运行标识>_<序号>__ 且顺序编号', () => {
    const result = protect('`a` 和 `b` 以及 `c`')
    expect(placeholdersOf(result)).toEqual([
      formatPlaceholder(RUN_ID, 0),
      formatPlaceholder(RUN_ID, 1),
      formatPlaceholder(RUN_ID, 2),
    ])
    expect(formatPlaceholder(RUN_ID, 7)).toBe(`__DT_${RUN_ID}_007__`)
  })

  it('运行标识保证不与原文中的占位符形状字符串碰撞', () => {
    const source = '请运行 __DT_DEADBF_001__ 检查状态'
    const scriptedRandom = (() => {
      let first = true
      return (length: number) => {
        if (first && length === 6) {
          first = false
          return 'DEADBF'
        }
        return 'F'.repeat(length)
      }
    })()
    const identifier = createRunIdentifier(source, scriptedRandom)
    expect(identifier).not.toBe('DEADBF')
    expect(`${PLACEHOLDER_PREFIX}${identifier}_`).not.toBe('__DT_DEADBF_')

    // 原文的同形字符串自身也被保护，还原后逐字保留。
    const result = protect(source, identifier)
    const restored = restore(result, identity(result.text), identifier)
    expect(restored.ok).toBe(true)
    if (restored.ok) expect(restored.text).toBe(source)
  })

  it('同一个占位符在译文中重复出现时判还原失败并保留原文', () => {
    const source = '先 `foo` 后 `bar`'
    const result = protect(source)
    const [first, second] = placeholdersOf(result)
    const duplicated = result.text.replace(second, first)
    const restored = restore(result, duplicated)
    expect(restored).toMatchObject({ ok: false, code: 'PLACEHOLDER_RESTORE_FAILED' })
    if (!restored.ok) expect(restored.text).toBe(source)
  })

  it.each([
    ['删除占位符', (text: string, first: string, _second: string) => text.replace(first, '')],
    ['改写占位符', (text: string, first: string, _second: string) => text.replace(first, first.replace(/_(\d+)__$/, '_99X__'))],
    ['乱序占位符', (text: string, first: string, second: string) => text.replace(first, '@@').replace(second, first).replace('@@', second)],
  ])('上游%s时保留原文并返回 PLACEHOLDER_RESTORE_FAILED', (_name, mutate) => {
    const source = '先 `foo` 后 `bar`'
    const result = protect(source)
    const [first, second] = placeholdersOf(result)
    const translated = mutate(result.text, first, second)
    const restored = restore(result, translated)
    expect(restored).toMatchObject({ ok: false, code: 'PLACEHOLDER_RESTORE_FAILED' })
    if (!restored.ok) expect(restored.text).toBe(source)
  })

  it('snake_case 与单星号斜体不被误保护', () => {
    const result = protect('my_var_name 和 *强调* 保持原样')
    expect(result.segmentMap.size).toBe(0)
    expect(result.text).toBe('my_var_name 和 *强调* 保持原样')
  })
})
