// Deterministic Provider fixture. It runs beside the Worker only in the test overlay.
import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'

export function startMockProvider(port = 3002) {
  const state = { holdAnswers: false, holdIndex: false, failAnswers: 0, started: {}, active: {}, aborted: {}, finished: {} }
  const server = createServer(async (request, response) => {
    try {
      if (request.url === '/__control') {
        if (request.method === 'POST') {
          const body = await readJSON(request)
          for (const name of ['holdAnswers', 'holdIndex', 'failAnswers']) {
            if (Object.hasOwn(body, name)) state[name] = body[name]
          }
        }
        response.setHeader('Content-Type', 'application/json')
        response.end(JSON.stringify(state))
        return
      }
      const body = await readJSON(request)
      const messages = body.messages ?? []
      const system = messages.filter(m => m.role === 'system' || m.role === 'developer').map(m => text(m.content)).join('\n')
      const question = text(messages.at(-1)?.content)
      const embedding = request.url === '/v1/embeddings'
      const inputs = Array.isArray(body.input) ? body.input : [body.input]
      const kind = embedding ? (body.model === 'fixture-index' ? 'index' : 'embedding')
        : /受控资料整理模型/.test(system) ? 'task'
          : /不超过 30 个字符/.test(system) ? 'title'
            : /confirmedFacts/.test(system) && /压缩/.test(system) ? 'summary'
              : /只生成检索查询|生成一条用于知识库检索/.test(system) ? 'rewrite' : 'answer'
      state.started[kind] = (state.started[kind] ?? 0) + 1
      state.active[kind] = (state.active[kind] ?? 0) + 1
      let finished = false
      response.on('close', () => {
        state.active[kind]--
        const counter = finished ? state.finished : state.aborted
        counter[kind] = (counter[kind] ?? 0) + 1
      })
      if (embedding) {
        while (state.holdIndex && !response.destroyed) await delay(50)
        if (response.destroyed) return
        response.setHeader('Content-Type', 'application/json')
        finished = true
        response.end(JSON.stringify({ object: 'list', data: inputs.map((input, index) => ({ object: 'embedding', index, embedding: vector(String(input)) })), model: body.model, usage: { prompt_tokens: inputs.length, total_tokens: inputs.length } }))
        return
      }
      if (kind === 'answer' && state.failAnswers > 0) {
        state.failAnswers--
        response.writeHead(400); response.end(JSON.stringify({ error: { message: 'synthetic failure' } })); return
      }
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
      const send = delta => response.write('data: ' + JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason: null }] }) + '\n\n')
      send({ role: 'assistant' })
      if (kind === 'answer' && body.reasoning_effort) {
        send({ reasoning_content: '先核对本轮笔记来源，再整理回答。'.repeat(8) })
        await delay(200)
      }
      while (kind === 'answer' && state.holdAnswers && !response.destroyed) await delay(50)
      if (response.destroyed) return
      let answer
      if (kind === 'title') answer = '织云节点巡检约定'
      else if (kind === 'summary') answer = JSON.stringify({ confirmedFacts: ['讨论合成巡检约定'], corrections: [], rejectedHypotheses: [], unresolvedQuestions: [] })
      else if (kind === 'rewrite') answer = /青岚/.test(question) ? '织云 青岚 巡检约定' : /火星/.test(question) ? '火星考古龙骨' : '织云 巡检约定'
      else if (kind === 'task') answer = JSON.stringify({ title: '织云节点巡检', summary: '合成资料整理', classification: { contentType: 'operations_guide', suggestedFolderPath: [], suggestedTags: [], sensitivitySuggestion: 'normal' }, blocks: [{ type: 'paragraph', text: '织云节点每日巡检。', sourceRefs: ['S1'] }], warnings: [], limitations: ['仅合成验收'] })
      else if (system.includes('当前知识库不可用')) answer = '知识库当前不可用。请完成索引配置后重试。'
      else if (system.includes('索引可用但未找到')) answer = '当前知识库未找到足够依据。'
      else {
        const sourceMessage = messages.find(m => /本轮检索到的知识库来源|本轮可引用的来源/.test(text(m.content)))
        const markers = [...new Set(text(sourceMessage?.content).match(/\[\[S[1-8]\]\]/g) ?? [])]
        answer = '笔记约定：织云每日 09:00 巡检，青岚每周一复核。' + markers.join(' ')
        if (/长文|代码/.test(question)) answer += '\n\n' + ('这是用于验证长中文换行和滚动跟随的合成资料说明。'.repeat(35)) + '\n\n```sh\nprintf "%s\\n" "' + 'long-synthetic-value-'.repeat(24) + '"\n```\n\n| 节点 | 约定 |\n| --- | --- |\n| 织云 | 每日巡检 |\n\n<script>window.fixtureExecuted = true</script>'
      }
      const width = kind === 'answer' ? 36 : 256
      for (let offset = 0; offset < answer.length && !response.destroyed; offset += width) {
        send({ content: answer.slice(offset, offset + width) })
        await delay(kind === 'answer' ? 50 : 1)
      }
      if (response.destroyed) return
      response.write('data: ' + JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 120, completion_tokens: 48, total_tokens: 168 } }) + '\n\n')
      finished = true
      response.end('data: [DONE]\n\n')
    } catch {
      if (!response.headersSent) response.writeHead(400)
      response.end('{}')
    }
  })
  server.listen(port, '0.0.0.0')
  return server
}

function vector(input) {
  if (/火星|龙骨/.test(input)) return [0, 0, 1]
  if (/织云/.test(input) && /青岚/.test(input)) return [1, 1, 0]
  if (/青岚/.test(input)) return [0, 1, 0]
  return [1, 0, 0]
}
function text(content) { return typeof content === 'string' ? content : Array.isArray(content) ? content.map(p => p.text ?? '').join('\n') : '' }
async function readJSON(request) { const chunks = []; for await (const chunk of request) chunks.push(chunk); return JSON.parse(Buffer.concat(chunks).toString() || '{}') }
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) startMockProvider()
