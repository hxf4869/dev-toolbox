import { digestLabels } from './digest/contracts'

export type ToolGroup = 'encoding' | 'development' | 'online'

export interface ToolLink {
  readonly name: string
  readonly routeName: string
  readonly path: string
  readonly description: string
  readonly icon:
    | 'binary'
    | 'braces'
    | 'link-2'
    | 'badge-check'
    | 'file-code-2'
    | 'calendar-clock'
    | 'hash'
    | 'regex'
    | 'languages'
    | 'scan-text'
  readonly group: ToolGroup
  readonly processing: 'local' | 'cloud'
  // 工具已有能力的名称（算法 ID、展示名等），只参与导航搜索的子串匹配，不展示。
  readonly searchTerms?: readonly string[]
}

// 这是当前已发布工具的静态导航元数据，不负责加载模块，也不构成插件注册器。
export const V2_TOOLS: readonly ToolLink[] = [
  {
    name: 'Base64',
    routeName: 'tool-base64',
    path: '/tools/base64',
    description: '在 UTF-8 文本与 Base64/Base64URL 之间转换。',
    icon: 'binary',
    group: 'encoding',
    processing: 'local',
  },
  {
    name: 'JSON 工作台',
    routeName: 'tool-json',
    path: '/tools/json',
    description: '格式化、查询、对比、Schema 校验与类型生成。',
    icon: 'braces',
    group: 'encoding',
    processing: 'local',
    searchTerms: ['JSONPath'],
  },
  {
    name: 'URL 编解码',
    routeName: 'tool-url',
    path: '/tools/url',
    description: '百分号编解码、URL 拆解与保序 Query 编辑。',
    icon: 'link-2',
    group: 'encoding',
    processing: 'local',
  },
  {
    name: 'JWT',
    routeName: 'tool-jwt',
    path: '/tools/jwt',
    description: '本地解码 Token，并按明确密钥校验签名和 Claims。',
    icon: 'badge-check',
    group: 'encoding',
    processing: 'local',
  },
  {
    name: 'YAML 工作台',
    routeName: 'tool-yaml',
    path: '/tools/yaml',
    description: 'YAML 1.2 格式化、校验以及 YAML/JSON 转换。',
    icon: 'file-code-2',
    group: 'encoding',
    processing: 'local',
  },
  {
    name: '时间与 Cron',
    routeName: 'tool-time',
    path: '/tools/time',
    description: '时间转换、日期计算、工作日与 Cron 预览。',
    icon: 'calendar-clock',
    group: 'development',
    processing: 'local',
  },
  {
    name: '摘要与校验和',
    routeName: 'tool-digest',
    path: '/tools/digest',
    description: '计算文本或单文件的哈希摘要并精确比对。',
    icon: 'hash',
    group: 'development',
    processing: 'local',
    searchTerms: [...Object.keys(digestLabels), ...Object.values(digestLabels)],
  },
  {
    name: '正则测试',
    routeName: 'tool-regex',
    path: '/tools/regex',
    description: '在一次性 Worker 中运行 JavaScript RegExp。',
    icon: 'regex',
    group: 'development',
    processing: 'local',
  },
  {
    name: '文本翻译',
    routeName: 'tool-translate',
    path: '/tools/translate',
    description: '把 Markdown 与技术文档的自然语言发送到阿里云机器翻译；代码与命令留在本机。',
    icon: 'languages',
    group: 'online',
    processing: 'cloud',
  },
  {
    name: 'OCR 翻译',
    routeName: 'tool-ocr',
    path: '/tools/ocr-translate',
    description: '浏览器本地识别图片文字并校对，可选发送阿里云重新识别或翻译。',
    icon: 'scan-text',
    group: 'online',
    processing: 'cloud',
  },
]
