import { computed, reactive, ref, shallowRef } from 'vue'
import { defineStore } from 'pinia'

import { useAuthStore } from '../../app/auth'
import { ApiError } from '../../lib/api'
import {
  createAssistantApi,
  type AssistantApi,
  type ConversationListQuery,
  type ConversationPatchRequest,
} from './assistantApi'
import type {
  AssistantBootstrapDTO,
  AssistantConversationDTO,
  AssistantFolderDTO,
  AssistantMessageDTO,
  AssistantModelDTO,
  AssistantRunDTO,
  AssistantSourceDTO,
  CitationRefDTO,
  EvidenceState,
  KnowledgeIndexStatusDTO,
  Reasoning,
  TemporaryHistoryMessageDTO,
  TemporarySourceDTO,
  TemporarySummaryDTO,
  UUID,
} from './assistantContracts'
import {
  createPersistentStreamState,
  createTemporaryStreamState,
  reducePersistentEvent,
  reduceTemporaryEvent,
  type PersistentStreamState,
  type TemporaryStreamState,
} from './assistantSse'

export interface TemporaryRuntimeInfo {
  status: 'running' | 'succeeded' | 'failed' | 'stopped'
  phase: AssistantRunDTO['phase']
  model: AssistantRunDTO['model']
  reasoning: AssistantRunDTO['reasoning']
  promptVersion: string | null
  retrievalVersion: string | null
  rewriteFallback: boolean
  knowledgeState: 'ready' | 'unavailable'
  evidenceState: EvidenceState | null
  usage: AssistantRunDTO['usage']
  timings: AssistantRunDTO['timings']
  providedSourceCount: number
  citationCount: number
  error: AssistantRunDTO['error']
}

export interface AssistantMessageViewModel {
  id: string
  role: 'user' | 'assistant'
  content: string
  reasoningContent: string | null
  reasoningDurationMs: number | null
  status: AssistantMessageDTO['status']
  citations: Array<CitationRefDTO | Omit<CitationRefDTO, 'runId'>>
  run: AssistantRunDTO | null
  temporaryRuntime: TemporaryRuntimeInfo | null
  temporary: boolean
}

export interface AssistantCitationSelection {
  citation: CitationRefDTO | Omit<CitationRefDTO, 'runId'>
  messageId: string
}

interface TemporaryMessageState extends AssistantMessageViewModel {
  sources: Record<number, TemporarySourceDTO>
}

interface TemporaryHistoryPlan {
  messages: TemporaryHistoryMessageDTO[]
  sourceIds: string[]
}

const DRAFT_PREFIX = 'dev-toolbox:assistant:draft:'
// docs/16 §12 临时会话滚动摘要合同：单次请求携带的历史消息上限 32 条；成功
// terminal 的 summary 覆盖本次 history 中除最近 16 条以外的最旧 prefix。
const TEMPORARY_HISTORY_LIMIT = 32
const TEMPORARY_SUMMARY_RETAINED = 16
// 知识索引轮询沿用 Provider 设置页的间隔与停止语义：仍有真实索引工作才轮询，
// 终态即停；失败不自动重试，由本页提示并等待显式重试。
const KNOWLEDGE_POLL_INTERVAL_MS = 2000

export const useAssistantStore = defineStore('assistant', () => {
  const auth = useAuthStore()
  const api = shallowRef<AssistantApi | null>(null)

  const bootstrap = ref<AssistantBootstrapDTO | null>(null)
  const folders = ref<AssistantFolderDTO[]>([])
  const conversations = ref<AssistantConversationDTO[]>([])
  const conversationNextCursor = ref<string | null>(null)
  const messages = ref<AssistantMessageDTO[]>([])
  const messageNextCursor = ref<string | null>(null)
  const activeConversation = ref<AssistantConversationDTO | null>(null)
  const conversationView = ref<'active' | 'archived'>('active')
  const folderFilter = ref<UUID | 'unfiled' | undefined>()

  const loading = ref(false)
  const navigationLoading = ref(false)
  const conversationLoading = ref(false)
  const sending = ref(false)
  const pageError = ref('')
  const actionError = ref('')
  const streamMessage = ref('')
  const reconnecting = ref(false)
  const knowledgePollError = ref('')

  const selectedModelId = ref<UUID | null>(null)
  const selectedReasoning = ref<Reasoning>('off')
  const modelReasonings = reactive<Record<UUID, Reasoning>>({})

  const temporaryMode = ref(false)
  const temporaryMessages = ref<TemporaryMessageState[]>([])
  const temporarySummary = ref<TemporarySummaryDTO | null>(null)
  const temporaryContextStart = ref(0)
  const persistentDraft = ref('')
  const temporaryDraft = ref('')

  let observationController: AbortController | null = null
  let temporaryController: AbortController | null = null
  let persistentState: PersistentStreamState | null = null
  // 当前观察的 Run：observePersistentRun 建立即设置，stopObservation 清理。判重
  // 不等首个 SSE snapshot（persistentState.run 在那之前还是 null），避免观察
  // 建立初期被重复启动并打断第一次连接。
  let observingRunId: UUID | null = null
  let knowledgePollTimer = 0
  let knowledgePollSeq = 0
  let navigationSeq = 0
  // 当前上下文（新对话/临时模式/选中会话/视图销毁）的归属序号：任何一次切换
  // 都使仍在途的持久发送（sendPersistent 的 startRun）迟到失效，旧响应不得
  // 抢回视图、混入消息、清掉新草稿或在别人的上下文里冒错。
  let contextSeq = 0
  // 视图是否处于挂载状态：销毁后未再挂载时，迟到的发送成功不得在后台启动
  // 新的观察流（无 stopObservation 的调用者会让重连循环一直挂着）。
  let viewAlive = true

  const models = computed(() => bootstrap.value?.models ?? [])
  const selectedModel = computed(
    () => models.value.find((model) => model.id === selectedModelId.value) ?? null,
  )
  const reasoningOptions = computed(() => selectedModel.value?.reasoningOptions ?? [])
  const draft = computed({
    get: () => (temporaryMode.value ? temporaryDraft.value : persistentDraft.value),
    set: (value: string) => {
      if (temporaryMode.value) temporaryDraft.value = value
      else {
        persistentDraft.value = value
        savePersistentDraft(value)
      }
    },
  })
  const activePersistentRun = computed(() => {
    // 只认最新一条带 Run 的消息：服务器保证一会话同时只有一个活动 Run，更早
    // 消息里的 running 只可能来自过期快照残留，不能当作当前运行。
    for (let index = messages.value.length - 1; index >= 0; index -= 1) {
      const run = messages.value[index]?.currentRun
      if (!run) continue
      return run.status === 'queued' || run.status === 'running' ? run : null
    }
    return null
  })
  const activeTemporaryMessage = computed(() =>
    [...temporaryMessages.value]
      .reverse()
      .find((message) => message.role === 'assistant' && message.status === 'streaming'),
  )
  const hasActiveRun = computed(() =>
    temporaryMode.value ? Boolean(activeTemporaryMessage.value) : Boolean(activePersistentRun.value),
  )
  const canStopActiveRun = computed(() =>
    temporaryMode.value ? Boolean(activeTemporaryMessage.value) : Boolean(activePersistentRun.value?.canStop),
  )
  const stopRequested = computed(
    () => !temporaryMode.value && Boolean(activePersistentRun.value?.stopRequested),
  )
  const selectionRequired = computed(
    () => !selectedModel.value || Boolean(activeConversation.value && !activeConversation.value.modelAvailable),
  )
  const canSend = computed(
    () =>
      !sending.value &&
      !hasActiveRun.value &&
      Boolean(selectedModel.value) &&
      draft.value.trim().length > 0,
  )
  const displayMessages = computed<AssistantMessageViewModel[]>(() => {
    if (temporaryMode.value) return temporaryMessages.value
    return messages.value.map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
      reasoningContent: message.reasoningContent,
      reasoningDurationMs: message.reasoningDurationMs,
      status: message.status,
      citations: message.citations,
      run: message.currentRun,
      temporaryRuntime: null,
      temporary: false,
    }))
  })

  function client(): AssistantApi {
    if (!api.value) api.value = createAssistantApi(() => auth.csrfToken)
    return api.value
  }

  function setApi(value: AssistantApi) {
    api.value = value
  }

  async function initialize() {
    if (loading.value) return
    viewAlive = true
    stopKnowledgePolling()
    knowledgePollError.value = ''
    // 归属序号：await 期间视图被销毁或被更新的 initialize 取代时（都会递增序号），
    // 本次返回的结果、错误与 loading 解除全部失效，不写入、不清新视图的草稿、
    // 不调度已离开视图的轮询。
    const seq = knowledgePollSeq
    loading.value = true
    pageError.value = ''
    try {
      const [bootstrapResponse, folderResponse, conversationResponse] = await Promise.all([
        client().getBootstrap(),
        client().getFolders(),
        client().getConversations({ view: conversationView.value, limit: 30 }),
      ])
      if (seq !== knowledgePollSeq) return
      bootstrap.value = bootstrapResponse
      folders.value = folderResponse.items
      conversations.value = conversationResponse.items
      conversationNextCursor.value = conversationResponse.nextCursor
      initializeSelections(bootstrapResponse)
      startNewConversation(false)
      scheduleKnowledgePolling()
    } catch (error) {
      if (seq !== knowledgePollSeq) return
      pageError.value = messageFor(error)
      if (bootstrap.value) actionError.value = pageError.value
    } finally {
      if (seq === knowledgePollSeq) loading.value = false
    }
  }

  function initializeSelections(value: AssistantBootstrapDTO) {
    for (const model of value.models) modelReasonings[model.id] = validLastReasoning(model)
    const selection = value.newConversationSelection
    if (!selection.required && selection.modelId) {
      selectedModelId.value = selection.modelId
      selectedReasoning.value = optionExists(selection.modelId, selection.reasoning)
        ? selection.reasoning
        : 'off'
      modelReasonings[selection.modelId] = selectedReasoning.value
    } else {
      selectedModelId.value = null
      selectedReasoning.value = 'off'
    }
  }

  // 导航读取的归属序号：最新一次非 append 读取（scope 切换或目录刷新）取代仍
  // 挂起的旧请求；旧请求的响应、错误与 finally 解锁按序号全部丢弃，不把旧
  // scope 的会话/游标写进新标题下。append（加载更多）仍沿用忙时直接返回：
  // 分页必须等上一次完成后用推进的 cursor 继续；它被新的非 append 读取取代
  // 时同样按序号丢弃，不把旧 scope 的下一页混入新列表。
  async function loadNavigation(append = false) {
    if (append && navigationLoading.value) return
    const seq = ++navigationSeq
    navigationLoading.value = true
    actionError.value = ''
    try {
      const query: ConversationListQuery = {
        view: conversationView.value,
        folderId: folderFilter.value,
        limit: 30,
        ...(append && conversationNextCursor.value
          ? { cursor: conversationNextCursor.value }
          : {}),
      }
      const [folderResponse, conversationResponse] = await Promise.all([
        client().getFolders(),
        client().getConversations(query),
      ])
      if (seq !== navigationSeq) return
      folders.value = folderResponse.items
      conversations.value = append
        ? mergeConversations(conversations.value, conversationResponse.items)
        : conversationResponse.items
      conversationNextCursor.value = conversationResponse.nextCursor
    } catch (error) {
      if (seq !== navigationSeq) return
      actionError.value = messageFor(error)
    } finally {
      if (seq === navigationSeq) navigationLoading.value = false
    }
  }

  async function setConversationView(value: 'active' | 'archived') {
    conversationView.value = value
    folderFilter.value = undefined
    conversations.value = []
    conversationNextCursor.value = null
    await loadNavigation()
  }

  // 文件夹筛选只存在于 active 视图（ModuleNav 的 scope 入口是唯一消费者）：
  // 单次同步确定 view 与 filter，并立刻清掉旧 scope 的列表/游标再发起读取；
  // 读取失败也只留下空列表与错误提示，不把旧 scope 会话留在新标题下。
  async function setFolderFilter(value: UUID | 'unfiled' | undefined) {
    conversationView.value = 'active'
    folderFilter.value = value
    conversations.value = []
    conversationNextCursor.value = null
    await loadNavigation()
  }

  function startNewConversation(focusDraft = true) {
    contextSeq += 1
    cancelTemporaryRunOnLeave()
    stopObservation()
    temporaryMode.value = false
    activeConversation.value = null
    messages.value = []
    messageNextCursor.value = null
    // 切换使在途历史读取失效（其 finally 按序号不再解锁），这里同步解除加载，
    // 新上下文没有读取任务。
    conversationLoading.value = false
    actionError.value = ''
    persistentDraft.value = readDraft('new')
    const selection = bootstrap.value?.newConversationSelection
    if (selection && !selection.required && selection.modelId) {
      selectedModelId.value = selection.modelId
      selectedReasoning.value = modelReasonings[selection.modelId] ?? selection.reasoning
    } else {
      selectedModelId.value = null
      selectedReasoning.value = 'off'
    }
    if (focusDraft) requestComposerFocus()
  }

  function startTemporaryConversation() {
    contextSeq += 1
    stopObservation()
    temporaryMode.value = true
    activeConversation.value = null
    messages.value = []
    // 分页入口只看 messageNextCursor 且无临时条件：旧会话 cursor 一并清掉，
    // 不留临时模式下点不开的“加载更早消息”。
    messageNextCursor.value = null
    // 同 startNewConversation：在途历史读取失效后立即解除加载。
    conversationLoading.value = false
    actionError.value = ''
    const selection = bootstrap.value?.newConversationSelection
    if (selection && !selection.required && selection.modelId) {
      selectedModelId.value = selection.modelId
      selectedReasoning.value = modelReasonings[selection.modelId] ?? selection.reasoning
    } else {
      selectedModelId.value = null
      selectedReasoning.value = 'off'
    }
    requestComposerFocus()
  }

  // 历史读取的归属序号：与导航读取同理，最新一次会话选择取代仍挂起的旧读取。
  // 不设忙时守卫（点击不被吞，最后意图生效）：等待期间切到新对话/临时模式/别的
  // 会话或销毁视图都递增 contextSeq，旧响应的消息/游标/观察恢复、错误提示与
  // finally 解锁按序号全部丢弃，不把旧会话历史写进新标题下，也不提前解除当前
  // 仍在进行的加载。
  async function selectConversation(conversation: AssistantConversationDTO) {
    contextSeq += 1
    const seq = contextSeq
    cancelTemporaryRunOnLeave()
    stopObservation()
    temporaryMode.value = false
    activeConversation.value = conversation
    actionError.value = ''
    // 立即清掉上一会话的消息/游标：读取延迟期间与读取失败后，新标题下不能挂着
    // 旧会话的历史（Thread 只在 messages 为空时显示读取态）；本次会话的草稿/
    // 模型选择不受影响。
    messages.value = []
    messageNextCursor.value = null
    persistentDraft.value = readDraft(conversation.id)
    if (conversation.modelAvailable && conversation.modelId) {
      selectedModelId.value = conversation.modelId
      selectedReasoning.value = optionExists(conversation.modelId, conversation.reasoning)
        ? conversation.reasoning
        : 'off'
      modelReasonings[conversation.modelId] = selectedReasoning.value
    } else {
      selectedModelId.value = null
      selectedReasoning.value = 'off'
      actionError.value = '此会话最近使用的模型已不可用，请重新选择模型。'
    }
    conversationLoading.value = true
    try {
      const response = await client().getMessages(conversation.id, { limit: 30 })
      if (seq !== contextSeq) return
      // 读取在途期间发送可能已把新 pair（含流式推进）合入本地（选择时已同步清
      // 空，无发送的正常路径本地为空数组，合并等价于替换）：旧快照按 id 并入，
      // 本地较新内容优先，不用旧快照覆盖丢掉新消息或流状态。
      messages.value = mergeMessages(response.items, messages.value)
      messageNextCursor.value = response.nextCursor
      // 观察恢复以合并后的当前消息为准，而不是旧 HTTP 快照：读取在途期间发送
      // 建立的新 Run 观察不被旧快照里已过期的 running 旧 Run 抢走；已在观察同
      // 一 Run 时不重启（observePersistentRun 会先停掉现有观察，重启中断推进）。
      const run = latestActiveRun(messages.value)
      if (run && observingRunId !== run.id) void observePersistentRun(run.id)
    } catch (error) {
      if (seq !== contextSeq) return
      actionError.value = messageFor(error)
    } finally {
      if (seq === contextSeq) conversationLoading.value = false
    }
  }

  // 分页沿用忙时直接返回（加载更多必须等上一次完成后用推进的 cursor 继续），
  // 但等待期间上下文被切换（新对话/临时模式/别的会话/销毁）时，迟到的旧页按
  // 序号丢弃，不把旧会话消息与游标混入或覆盖当前上下文。
  async function loadOlderMessages() {
    if (!activeConversation.value || !messageNextCursor.value || conversationLoading.value) return
    const seq = contextSeq
    conversationLoading.value = true
    try {
      const response = await client().getMessages(activeConversation.value.id, {
        before: messageNextCursor.value,
        limit: 30,
      })
      if (seq !== contextSeq) return
      messages.value = mergeMessages(response.items, messages.value)
      messageNextCursor.value = response.nextCursor
    } catch (error) {
      if (seq !== contextSeq) return
      actionError.value = messageFor(error)
    } finally {
      if (seq === contextSeq) conversationLoading.value = false
    }
  }

  function chooseModel(modelId: UUID | null) {
    selectedModelId.value = modelId
    if (!modelId) {
      selectedReasoning.value = 'off'
      return
    }
    const model = models.value.find((entry) => entry.id === modelId)
    const next = modelReasonings[modelId] ?? (model ? validLastReasoning(model) : 'off')
    selectedReasoning.value = optionExists(modelId, next) ? next : 'off'
    modelReasonings[modelId] = selectedReasoning.value
  }

  function chooseReasoning(reasoning: Reasoning) {
    if (!selectedModelId.value || !optionExists(selectedModelId.value, reasoning)) return
    selectedReasoning.value = reasoning
    modelReasonings[selectedModelId.value] = reasoning
  }

  async function send() {
    actionError.value = ''
    if (!draft.value.trim()) {
      actionError.value = '请输入消息后再发送。'
      return
    }
    if (!selectedModelId.value || !selectedModel.value) {
      actionError.value = models.value.length
        ? '请先明确选择本次使用的模型。'
        : '尚无可用模型，请先前往 Provider 与模型设置。'
      return
    }
    if (hasActiveRun.value || sending.value) return
    if (temporaryMode.value) await sendTemporary()
    else await sendPersistent()
  }

  async function sendPersistent() {
    if (!selectedModelId.value) return
    const content = persistentDraft.value
    const draftKey = activeConversation.value?.id ?? 'new'
    // 捕获发送时刻的模型/思考与上下文归属：startRun 迟到返回时，等待期间的
    // 新选择、新草稿或上下文切换不得被本次响应覆盖或污染。
    const modelId = selectedModelId.value
    const reasoning = selectedReasoning.value
    const seq = contextSeq
    sending.value = true
    try {
      const response = await client().startRun({
        clientRequestId: createClientRequestId(),
        conversationId: activeConversation.value?.id ?? null,
        ...(!activeConversation.value
          ? { folderId: folderFilter.value && folderFilter.value !== 'unfiled' ? folderFilter.value : null }
          : {}),
        content,
        modelId,
        reasoning,
      })
      modelReasonings[modelId] = reasoning
      void loadNavigation()
      // A→B→A：等待期间用户离开又回到本次发送的目标会话（回切读取发生在 Run
      // 创建之前、看不到 activeRun）时，本次 pair 与观察仍要在 A 恢复。
      const backOnTarget =
        viewAlive &&
        !temporaryMode.value &&
        activeConversation.value?.id === response.conversation.id
      if (seq !== contextSeq && !backOnTarget) {
        // 迟到成功：视图已切到别的会话或临时模式。不抢回 activeConversation、
        // 不把旧会话消息混入当前 messages、不动当前草稿、不接管观察（用户切回
        // 该会话时由 selectConversation 重新拉取并恢复观察）；但已发送内容残留
        // 在旧草稿键上时仍清理，键值已被编辑成新草稿的保留。
        if (readDraft(draftKey) === content) removeDraft(draftKey)
        // 当前视图若仍展示这条已发送内容（新会话发送后切走又回到新对话页，
        // 回切把已发送内容读回了内存），同步清掉内存草稿，避免 sending 释放
        // 后重复提交；用户已编辑出的新内容不受影响。
        if (
          !temporaryMode.value &&
          (activeConversation.value?.id ?? 'new') === draftKey &&
          persistentDraft.value === content
        ) {
          persistentDraft.value = ''
        }
        return
      }
      activeConversation.value = response.conversation
      messages.value = mergeMessages(messages.value, [response.userMessage, response.assistantMessage])
      if (persistentDraft.value === content) {
        persistentDraft.value = ''
        removeDraft(draftKey)
        removeDraft(response.conversation.id)
      } else if (draftKey !== response.conversation.id) {
        // 新会话首条发送期间又编辑了草稿：'new' 键上的未发送内容迁移到新会话键。
        removeDraft(draftKey)
        savePersistentDraft(persistentDraft.value)
      }
      void observePersistentRun(response.run.id)
    } catch (error) {
      // 迟到失败只属于发送时的上下文；失败内容留在原草稿键上，切回可重试。
      if (seq === contextSeq) actionError.value = actionMessageFor(error)
    } finally {
      sending.value = false
    }
  }

  async function sendTemporary() {
    if (!selectedModelId.value || !selectedModel.value) return
    // 发送前（push 乐观 pair 之前）先对全量数组计算本次将携带的成功对历史：
    // 超过合同上限时本地拦截，不 push、不清草稿、不发请求、本地消息完整保留。
    // 无“重开临时会话”入口（临时会话即当前标签页内存），提示复制后刷新重开；
    // 草稿保留到用户自行刷新，不新增清空按钮或弹窗机制。
    const history = temporaryHistoryBefore()
    if (history.messages.length > TEMPORARY_HISTORY_LIMIT) {
      actionError.value = '临时会话未摘要的历史已达上限；如需保留内容请先复制，刷新页面后重新开始临时会话。'
      return
    }
    const content = temporaryDraft.value
    const model = selectedModel.value
    const reasoningOption = model.reasoningOptions.find(
      (option) => option.reasoning === selectedReasoning.value,
    )
    const userId = `temporary-user-${createClientRequestId()}`
    const assistantId = `temporary-assistant-${createClientRequestId()}`
    const requestId = createClientRequestId()
    const userMessage: TemporaryMessageState = {
      id: userId,
      role: 'user',
      content,
      reasoningContent: null,
      reasoningDurationMs: null,
      status: 'complete',
      citations: [],
      run: null,
      temporaryRuntime: null,
      temporary: true,
      sources: {},
    }
    const assistantMessage: TemporaryMessageState = {
      id: assistantId,
      role: 'assistant',
      content: '',
      reasoningContent: null,
      reasoningDurationMs: null,
      status: 'streaming',
      citations: [],
      run: null,
      temporaryRuntime: {
        status: 'running',
        phase: null,
        model: {
          id: model.id,
          displayName: model.displayName,
          upstreamModelId: model.upstreamModelId,
          contextWindow: model.contextWindow,
          providerId: model.provider.id,
          providerDisplayName: model.provider.displayName,
        },
        reasoning: {
          reasoning: selectedReasoning.value,
          displayName: reasoningOption?.displayName ?? '不思考',
        },
        promptVersion: null,
        retrievalVersion: null,
        rewriteFallback: false,
        knowledgeState: bootstrap.value?.knowledge.available ? 'ready' : 'unavailable',
        evidenceState: null,
        usage: emptyUsage(),
        timings: emptyTimings(),
        providedSourceCount: 0,
        citationCount: 0,
        error: null,
      },
      temporary: true,
      sources: {},
    }
    temporaryMessages.value.push(userMessage, assistantMessage)
    const controller = new AbortController()
    temporaryController = controller
    const initialDraft = temporaryDraft.value
    let accepted = false
    sending.value = true
    let streamState = createTemporaryStreamState()
    try {
      for await (const envelope of client().streamTemporaryRun(
        {
          clientRequestId: requestId,
          modelId: selectedModelId.value,
          reasoning: selectedReasoning.value,
          summary: temporarySummary.value,
          messages: history.messages,
          content,
        },
        controller.signal,
      )) {
        if (controller.signal.aborted) break
        if (!accepted) {
          accepted = true
          temporaryDraft.value = temporaryDraft.value === initialDraft ? '' : temporaryDraft.value
          modelReasonings[selectedModelId.value] = selectedReasoning.value
        }
        const reduced = reduceTemporaryEvent(streamState, envelope)
        streamState = reduced.state
        applyTemporaryStream(assistantId, streamState)
        if (reduced.diagnostic) console.warn('[assistant-sse]', reduced.diagnostic)
        if (reduced.outcome === 'needs_snapshot') {
          throw new Error('临时回答流不连续，已在本地停止。')
        }
        if (reduced.outcome === 'terminal') break
      }
      if (controller.signal.aborted) {
        stopTemporaryMessage(assistantId)
        return
      }
      if (!streamState.terminal) throw new Error('临时回答连接已中断。')
      // 未 seed 旧摘要：这里 streamState.summary 非 null 只可能是 succeeded terminal
      // 实际携带了新摘要；失败/停止/未携带时摘要与水位都保持不动。
      if (streamState.status === 'succeeded' && streamState.summary !== null) {
        advanceTemporaryCoverage(history.sourceIds, streamState.summary)
      }
    } catch (error) {
      if (controller.signal.aborted) {
        stopTemporaryMessage(assistantId)
        return
      }
      if (!accepted) {
        temporaryMessages.value = temporaryMessages.value.filter(
          (message) => message.id !== userId && message.id !== assistantId,
        )
      } else {
        failTemporaryMessage(assistantId, actionMessageFor(error))
      }
      actionError.value = actionMessageFor(error)
    } finally {
      // 旧运行的收尾不得清掉新运行的 controller/sending（按 controller 身份守卫）。
      if (temporaryController === controller) {
        temporaryController = null
        sending.value = false
      }
    }
  }

  async function stopActiveRun() {
    actionError.value = ''
    if (temporaryMode.value) {
      const message = activeTemporaryMessage.value
      if (message) stopTemporaryMessage(message.id)
      temporaryController?.abort()
      return
    }
    const run = activePersistentRun.value
    if (!run || !run.canStop) return
    // 捕获停止时刻的上下文归属：stopRun 迟到返回时，等待期间已切到别的会话/
    // 新对话/临时模式或视图销毁，旧错误不得写进别人的上下文；成功更新与失败
    // 提示都按 Run 身份归属（updateRunInMessages、观察与 activePersistentRun
    // 判重），回到同一会话且 Run 未被替代时仍正常生效。
    const seq = contextSeq
    try {
      const updated = await client().stopRun(run.id)
      updateRunInMessages(updated)
      // 只停止仍在观察这个 Run 的观察：等待期间观察已被别的会话或同一位置的
      // 新重试 Run 接管时，迟到停止不得中止别人的流。
      if (updated.status === 'stopped' && observingRunId === updated.id) stopObservation()
    } catch (error) {
      // 上下文未变还不够：同一会话里 SSE 可能已先送达 stopped 且用户已重试出
      // 新 Run，旧停止失败不得冒给替代 Run；当前活动 Run 仍是本次停止的 Run
      // （真实停止失败，Run 仍在运行）时才提示。
      if (seq === contextSeq && activePersistentRun.value?.id === run.id) {
        actionError.value = actionMessageFor(error)
      }
    }
  }

  async function retryLastAnswer(runId: UUID) {
    actionError.value = ''
    if (!selectedModelId.value) {
      actionError.value = '请先选择重试使用的模型和思考档位。'
      return
    }
    // sending 守卫：请求在途时重试按钮仍可点，不因占位尚未建立而发出第二次。
    if (hasActiveRun.value || sending.value) return
    // 捕获重试时刻的上下文归属：retryRun 迟到返回时，等待期间切换到别的会话、
    // 新对话、临时模式或销毁视图后，旧响应不得抢回视图、混入消息、接管观察或
    // 在别人的上下文里冒错（与 sendPersistent 同一归属语义）。
    const seq = contextSeq
    sending.value = true
    try {
      const response = await client().retryRun(runId, {
        clientRequestId: createClientRequestId(),
        modelId: selectedModelId.value,
        reasoning: selectedReasoning.value,
      })
      // A→B→A：等待期间用户离开又回到重试的目标会话时，本次替换与观察仍要在
      // 该会话恢复。
      const backOnTarget =
        viewAlive &&
        !temporaryMode.value &&
        activeConversation.value?.id === response.conversation.id
      if (seq !== contextSeq && !backOnTarget) {
        // 迟到成功：不抢回 activeConversation、不混入当前 messages、不动当前
        // 草稿与模型选择、不接管观察；切回该会话时由 selectConversation 重新
        // 拉取并恢复观察。
        return
      }
      // 回切读取可能已拿到同一新 Run 并由观察推进正文：迟到 202 的空快照不覆
      // 写新正文、不替换会话摘要；仍在旧 Run 或读取未归位（messages 尚空）时
      // 才落本次快照，响应携带的原 user 消息与助手占位一并按 sequence 合入，
      // 回切历史在途或读取失败时不缺原问题，也不丢回切已恢复的占位。
      const existing = messages.value.find((entry) => entry.id === response.assistantMessage.id)
      if (existing?.currentRun?.id !== response.run.id) {
        activeConversation.value = response.conversation
        messages.value = mergeMessages(messages.value, [
          response.userMessage,
          response.assistantMessage,
        ])
      }
      // 已在观察同一新 Run 时不重启：observePersistentRun 会先停掉现有观察，
      // 重启会中断正在推进的同一 Run。
      if (observingRunId !== response.run.id) void observePersistentRun(response.run.id)
    } catch (error) {
      // 迟到失败只属于重试时的上下文。
      if (seq === contextSeq) actionError.value = actionMessageFor(error)
    } finally {
      sending.value = false
    }
  }

  async function observePersistentRun(runId: UUID) {
    stopObservation()
    observationController = new AbortController()
    const controller = observationController
    observingRunId = runId
    persistentState = createPersistentStreamState()
    reconnecting.value = false
    streamMessage.value = ''

    while (!controller.signal.aborted) {
      try {
        for await (const envelope of client().streamPersistentRun(runId, {
          afterSequence: persistentState.appliedSequence,
          signal: controller.signal,
        })) {
          const reduced = reducePersistentEvent(persistentState, envelope)
          persistentState = reduced.state
          applyPersistentStream(persistentState)
          if (reduced.diagnostic) console.warn('[assistant-sse]', reduced.diagnostic)
          if (reduced.outcome === 'needs_snapshot') break
          if (reduced.outcome === 'terminal') {
            reconnecting.value = false
            streamMessage.value = ''
            void loadNavigation()
            return
          }
        }
        if (controller.signal.aborted || persistentState.terminal) return
        reconnecting.value = true
        streamMessage.value = '连接暂时中断，正在恢复回答…'
      } catch (error) {
        if (controller.signal.aborted || isAbortError(error)) return
        // SSE 断线后会话失效（窄 401，与 auth.logout 同一判定）：重连只会继续
        // 401。停止本次观察并清理重连状态与观察占用，不伪造 Run 失败或取消，
        // 也不动已收到的消息、当前会话、草稿与模型选择；重新登录后重新选择
        // 会话即可恢复观察。非 AUTH_REQUIRED 的 401 仍按网络错误重连。
        if (error instanceof ApiError && error.status === 401 && error.code === 'AUTH_REQUIRED') {
          stopObservation()
          streamMessage.value = '登录已失效，已停止恢复回答；请退出登录后重新登录。'
          return
        }
        if (error instanceof ApiError && error.status === 404) {
          // Run 已在服务端被删除或清理：结束本次观察并清掉重连状态，不再
          // 显示“正在恢复回答”；保留已收到的消息与准确错误反馈，不伪造
          // failed/cancelled，也不动草稿与模型选择。
          stopObservation()
          actionError.value = error.message
          return
        }
        reconnecting.value = true
        streamMessage.value = '连接暂时中断，正在恢复回答…'
      }
      await reconnectDelay(controller.signal)
    }
  }

  function applyPersistentStream(state: PersistentStreamState) {
    if (!state.assistantMessage || !state.run) return
    const nextMessage = state.assistantMessage
    const index = messages.value.findIndex((message) => message.id === nextMessage.id)
    if (index >= 0) messages.value.splice(index, 1, nextMessage)
    else messages.value.push(nextMessage)
    if (activeConversation.value) {
      activeConversation.value = {
        ...activeConversation.value,
        latestRun: summaryFromRun(state.run),
      }
    }
  }

  function applyTemporaryStream(assistantId: string, state: TemporaryStreamState) {
    const message = temporaryMessages.value.find((entry) => entry.id === assistantId)
    if (!message || !message.temporaryRuntime) return
    message.content = state.content
    message.reasoningContent = state.reasoningContent || null
    message.reasoningDurationMs = state.reasoningDurationMs
    message.status = state.status === 'succeeded'
      ? 'complete'
      : state.status === 'failed'
        ? 'failed'
        : state.status === 'stopped'
          ? 'stopped'
          : 'streaming'
    message.citations = state.citations
    message.sources = state.sources
    const knowledge = sourceKnowledgeFromTemporaryState(state, message.temporaryRuntime)
    message.temporaryRuntime = {
      ...message.temporaryRuntime,
      status: state.status === 'idle' ? 'running' : state.status,
      phase: state.phase,
      model: state.model ?? message.temporaryRuntime.model,
      promptVersion: state.promptVersion,
      retrievalVersion: state.retrievalVersion,
      rewriteFallback: state.rewriteFallback,
      knowledgeState: knowledge.knowledgeState,
      evidenceState: knowledge.evidenceState,
      usage: state.usage,
      timings: state.timings,
      providedSourceCount: knowledge.providedSourceCount,
      citationCount: state.citations.length,
      error: state.error,
    }
  }

  function failTemporaryMessage(id: string, messageText: string) {
    const message = temporaryMessages.value.find((entry) => entry.id === id)
    if (!message || !message.temporaryRuntime) return
    message.status = 'failed'
    message.temporaryRuntime = {
      ...message.temporaryRuntime,
      status: 'failed',
      phase: null,
      error: { code: 'ASSISTANT_STREAM_DISCONNECTED', message: messageText },
    }
  }

  function stopTemporaryMessage(id: string) {
    const message = temporaryMessages.value.find((entry) => entry.id === id)
    if (!message || !message.temporaryRuntime) return
    message.status = 'stopped'
    message.temporaryRuntime = {
      ...message.temporaryRuntime,
      status: 'stopped',
      phase: null,
    }
  }

  async function getSource(
    citation: CitationRefDTO | Omit<CitationRefDTO, 'runId'>,
    temporaryMessageId?: string,
  ): Promise<AssistantSourceDTO | TemporarySourceDTO> {
    if (!('runId' in citation)) {
      const message = temporaryMessages.value.find((entry) => entry.id === temporaryMessageId)
      const source = message?.sources[citation.citationNumber]
      if (!source) throw new Error('临时来源已不可用。')
      return source
    }
    // 持久来源不在会话生命周期内缓存：每次打开/重试都直连服务端重新确认当前
    // 标题、删除态与 Run 有效性（被 retry 取代的旧 Run 由服务端返回 NOT_FOUND）。
    return client().getSource(citation.runId, citation.citationNumber)
  }

  async function patchConversation(id: UUID, value: ConversationPatchRequest) {
    actionError.value = ''
    try {
      const updated = await client().patchConversation(id, value)
      replaceConversation(updated)
      if (activeConversation.value?.id === id) activeConversation.value = updated
      await loadNavigation()
      return updated
    } catch (error) {
      actionError.value = actionMessageFor(error)
      throw error
    }
  }

  async function removeConversation(id: UUID) {
    actionError.value = ''
    try {
      await client().deleteConversation(id)
      conversations.value = conversations.value.filter((entry) => entry.id !== id)
      removeDraft(id)
      if (activeConversation.value?.id === id) startNewConversation(false)
      await loadNavigation()
    } catch (error) {
      actionError.value = actionMessageFor(error)
      throw error
    }
  }

  async function createFolder(name: string) {
    const created = await client().createFolder(name.trim())
    folders.value = [...folders.value, created].sort(folderSort)
    return created
  }

  async function renameFolder(id: UUID, name: string) {
    const updated = await client().renameFolder(id, name.trim())
    folders.value = folders.value.map((folder) => (folder.id === id ? updated : folder)).sort(folderSort)
    return updated
  }

  async function deleteFolder(id: UUID, action: 'unfile' | 'delete') {
    await client().deleteFolder(id, action)
    folders.value = folders.value.filter((folder) => folder.id !== id)
    if (action === 'unfile') {
      conversations.value = conversations.value.map((conversation) =>
        conversation.folderId === id ? { ...conversation, folderId: null } : conversation,
      )
    } else {
      conversations.value = conversations.value.filter((conversation) => conversation.folderId !== id)
      if (activeConversation.value?.folderId === id) startNewConversation(false)
    }
    if (folderFilter.value === id) folderFilter.value = undefined
    await loadNavigation()
  }

  function resetTemporaryConversation() {
    // 销毁时同样要释放这条临时运行占有的 sending：直接复用离开会话的取消逻辑
    //（temporaryMode/temporaryController 守卫保证不会误清持久发送的状态）。
    cancelTemporaryRunOnLeave()
    temporaryMessages.value = []
    temporarySummary.value = null
    temporaryContextStart.value = 0
    temporaryDraft.value = ''
  }

  // 真正离开临时会话（切到持久会话、新建会话或视图销毁）时传播取消：abort 旧
  // 临时流（按 docs/16 §12 取消传播到 Worker 与 Provider）、把进行中的临时回答
  // 标记为 stopped，并恢复持久发送能力。重新点击“临时对话”导航不经过这里，
  // 不会取消进行中的生成；旧流随后的收尾由 sendTemporary 内的 controller 守卫
  // 挡住。
  function cancelTemporaryRunOnLeave() {
    if (!temporaryMode.value || !temporaryController) return
    const controller = temporaryController
    temporaryController = null
    const message = activeTemporaryMessage.value
    if (message) stopTemporaryMessage(message.id)
    controller.abort()
    sending.value = false
  }

  function disposeView() {
    stopKnowledgePolling()
    contextSeq += 1
    viewAlive = false
    // 视图已销毁：仍挂起的 initialize 返回后会被序号挡住写入，这里同时解除它
    // 占有的 loading，让下一次挂载能立即重新初始化。挂起的导航读取与历史读取
    // 同样失效并解除各自 loading；迟到的旧响应不写入，旧 finally 不重复解锁。
    navigationSeq += 1
    navigationLoading.value = false
    conversationLoading.value = false
    loading.value = false
    stopObservation()
    resetTemporaryConversation()
  }

  function stopObservation() {
    observationController?.abort()
    observationController = null
    observingRunId = null
    persistentState = null
    reconnecting.value = false
    streamMessage.value = ''
  }

  // 知识索引状态轮询：仅在视图挂载期间、且索引仍有真实工作时递归定时读取
  // getIndexStatus，成功后只替换 bootstrap.knowledge（不清会话/草稿/模型选择，
  // 不重新 initialize）。停止时递增序号，使迟到的响应与回调全部失效，不污染
  // 下一次挂载的数据，也不复活轮询；GET 失败保留最近成功状态并停转，等待显式
  // 重试或下一次 initialize。
  function stopKnowledgePolling() {
    window.clearTimeout(knowledgePollTimer)
    knowledgePollTimer = 0
    knowledgePollSeq += 1
  }

  function scheduleKnowledgePolling() {
    window.clearTimeout(knowledgePollTimer)
    knowledgePollTimer = 0
    const knowledge = bootstrap.value?.knowledge
    if (!knowledge || !knowledgeHasPendingWork(knowledge)) return
    const seq = knowledgePollSeq
    knowledgePollTimer = window.setTimeout(() => {
      knowledgePollTimer = 0
      if (seq !== knowledgePollSeq) return
      void pollKnowledgeStatus()
    }, KNOWLEDGE_POLL_INTERVAL_MS)
  }

  async function pollKnowledgeStatus() {
    const seq = knowledgePollSeq
    try {
      const status = await client().getIndexStatus()
      if (seq !== knowledgePollSeq || !bootstrap.value) return
      bootstrap.value = { ...bootstrap.value, knowledge: status }
      knowledgePollError.value = ''
      scheduleKnowledgePolling()
    } catch (error) {
      if (seq !== knowledgePollSeq) return
      knowledgePollError.value = messageFor(error)
    }
  }

  async function retryKnowledgeRefresh() {
    stopKnowledgePolling()
    knowledgePollError.value = ''
    await pollKnowledgeStatus()
  }

  function requestComposerFocus() {
    if (typeof window === 'undefined') return
    window.setTimeout(() => {
      document.querySelector<HTMLTextAreaElement>('[data-assistant-composer]')?.focus()
    }, 0)
  }

  function savePersistentDraft(value: string) {
    if (typeof sessionStorage === 'undefined') return
    const key = activeConversation.value?.id ?? 'new'
    if (value) sessionStorage.setItem(`${DRAFT_PREFIX}${key}`, value)
    else sessionStorage.removeItem(`${DRAFT_PREFIX}${key}`)
  }

  function readDraft(key: string) {
    if (typeof sessionStorage === 'undefined') return ''
    return sessionStorage.getItem(`${DRAFT_PREFIX}${key}`) ?? ''
  }

  function removeDraft(key: string) {
    if (typeof sessionStorage !== 'undefined') sessionStorage.removeItem(`${DRAFT_PREFIX}${key}`)
  }

  function replaceConversation(updated: AssistantConversationDTO) {
    const index = conversations.value.findIndex((entry) => entry.id === updated.id)
    if (index >= 0) conversations.value.splice(index, 1, updated)
  }

  // 只写回仍属于该 Run 的助手消息：docs/16 §11.3 重试复用原助手消息位置并把
  // current_run_id 切到新 Run，旧 Run 迟到的停止响应不得在同一位置覆盖新 Run。
  function updateRunInMessages(run: AssistantRunDTO) {
    const message = messages.value.find((entry) => entry.id === run.outputMessageId)
    if (!message || message.currentRun?.id !== run.id) return
    message.currentRun = run
    if (run.status === 'stopped') {
      message.status = 'stopped'
      message.completedAt = run.finishedAt
    }
  }

  function optionExists(modelId: UUID, reasoning: Reasoning) {
    const model = models.value.find((entry) => entry.id === modelId)
    return Boolean(model?.reasoningOptions.some((option) => option.reasoning === reasoning))
  }

  // docs/16 §10.2/§12：临时历史只携带完整成功的 user+assistant 对；failed/stopped
  // 的整对排除（后端 temporary 校验要求 user/assistant 严格交替且总数为偶数），
  // user 原文不改写，[[C#]] 过滤只作用于 assistant 历史。sourceIds 与 messages
  // 一一对应，记录实际进入本次请求的本地消息 ID 序列，供水位推进使用；不做静默
  // 截断，超过上限由 sendTemporary 在发送前本地拦截。
  function temporaryHistoryBefore(): TemporaryHistoryPlan {
    const messages: TemporaryHistoryMessageDTO[] = []
    const sourceIds: string[] = []
    let pendingUser: { id: string; content: string } | null = null
    for (const message of temporaryMessages.value.slice(temporaryContextStart.value)) {
      if (message.role === 'user') {
        if (pendingUser === null && message.status === 'complete') {
          pendingUser = { id: message.id, content: message.content }
        }
      } else if (pendingUser !== null && message.status === 'complete' &&
        message.temporaryRuntime?.status === 'succeeded') {
        messages.push({ role: 'user', content: pendingUser.content })
        messages.push({ role: 'assistant', content: stripCitationTokens(message.content) })
        sourceIds.push(pendingUser.id, message.id)
        pendingUser = null
      } else if (pendingUser !== null) {
        pendingUser = null
      }
    }
    return { messages, sourceIds }
  }

  // docs/16 §12：成功 terminal 携带的 summary 覆盖“本次发送 history 中除最近
  // 16 条以外的整个最旧 prefix”（叠加旧摘要已覆盖部分）。按发送时记录的实际
  // history 消息 ID 序列推进水位：水位落在最后一条被覆盖消息之后，绝不越过
  // 未覆盖的成功消息；failed/stopped 不在成功序列中，也不计入保留的 16 条。
  // 找不到对应 ID（理论上不可达）时不推进，只更新摘要。
  function advanceTemporaryCoverage(historySourceIds: string[], summary: TemporarySummaryDTO) {
    const coveredCount = historySourceIds.length - TEMPORARY_SUMMARY_RETAINED
    if (coveredCount > 0) {
      const lastCoveredId = historySourceIds[coveredCount - 1]
      const index = temporaryMessages.value.findIndex((message) => message.id === lastCoveredId)
      if (index >= 0 && index + 1 > temporaryContextStart.value) {
        temporaryContextStart.value = index + 1
      }
    }
    temporarySummary.value = summary
  }

  return {
    bootstrap,
    folders,
    conversations,
    conversationNextCursor,
    messages,
    messageNextCursor,
    activeConversation,
    conversationView,
    folderFilter,
    loading,
    navigationLoading,
    conversationLoading,
    sending,
    pageError,
    actionError,
    streamMessage,
    reconnecting,
    knowledgePollError,
    selectedModelId,
    selectedReasoning,
    temporaryMode,
    temporaryMessages,
    models,
    selectedModel,
    reasoningOptions,
    draft,
    hasActiveRun,
    canStopActiveRun,
    stopRequested,
    selectionRequired,
    canSend,
    displayMessages,
    setApi,
    initialize,
    loadNavigation,
    setConversationView,
    setFolderFilter,
    startNewConversation,
    startTemporaryConversation,
    selectConversation,
    loadOlderMessages,
    chooseModel,
    chooseReasoning,
    send,
    stopActiveRun,
    retryLastAnswer,
    retryKnowledgeRefresh,
    getSource,
    patchConversation,
    removeConversation,
    createFolder,
    renameFolder,
    deleteFolder,
    resetTemporaryConversation,
    disposeView,
  }
})

function validLastReasoning(model: AssistantModelDTO): Reasoning {
  return model.reasoningOptions.some((option) => option.reasoning === model.lastReasoning)
    ? model.lastReasoning
    : 'off'
}

// 与 activePersistentRun 同一契约：只认最新一条带 Run 的消息。服务器保证一会
// 话同时只有一个活动 Run，更早消息里的 queued/running 只可能来自过期快照残留，
// 不能据其恢复观察。
function latestActiveRun(items: AssistantMessageDTO[]) {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const run = items[index]?.currentRun
    if (!run) continue
    return run.status === 'queued' || run.status === 'running' ? run : null
  }
  return null
}

function knowledgeHasPendingWork(status: KnowledgeIndexStatusDTO) {
  if (status.status === 'disabled' || status.status === 'unconfigured') return false
  return status.status === 'indexing' || status.counts.pending > 0 || status.counts.running > 0
}

function mergeConversations(
  current: AssistantConversationDTO[],
  incoming: AssistantConversationDTO[],
) {
  const byId = new Map(current.map((entry) => [entry.id, entry]))
  for (const entry of incoming) byId.set(entry.id, entry)
  return [...byId.values()]
}

function mergeMessages(current: AssistantMessageDTO[], incoming: AssistantMessageDTO[]) {
  const byId = new Map(current.map((entry) => [entry.id, entry]))
  for (const entry of incoming) byId.set(entry.id, entry)
  return [...byId.values()].sort((left, right) => left.sequence - right.sequence)
}

function folderSort(left: AssistantFolderDTO, right: AssistantFolderDTO) {
  return left.name.localeCompare(right.name, 'zh-CN') || left.id.localeCompare(right.id)
}

function summaryFromRun(run: AssistantRunDTO) {
  return {
    id: run.id,
    status: run.status,
    phase: run.phase,
    stopRequested: run.stopRequested,
    canStop: run.canStop,
    canRetry: run.canRetry,
    error: run.error,
    createdAt: run.createdAt,
    finishedAt: run.finishedAt,
  }
}

function emptyUsage(): AssistantRunDTO['usage'] {
  return {
    answerContextTokens: null,
    rewriteInputTokens: null,
    rewriteOutputTokens: null,
    answerInputTokens: null,
    answerOutputTokens: null,
  }
}

function emptyTimings(): AssistantRunDTO['timings'] {
  return {
    rewriteMs: null,
    embeddingMs: null,
    retrievalMs: null,
    reasoningMs: null,
    answerMs: null,
    totalMs: null,
  }
}

function sourceKnowledgeFromTemporaryState(
  state: TemporaryStreamState,
  fallback: TemporaryRuntimeInfo,
) {
  return {
    knowledgeState: state.knowledgeState ?? fallback.knowledgeState,
    evidenceState: state.evidenceState ?? fallback.evidenceState,
    providedSourceCount: Math.max(
      state.providedSourceCount,
      fallback.providedSourceCount,
      Object.keys(state.sources).length,
    ),
  }
}

function createClientRequestId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  throw new Error('当前浏览器不支持安全的 UUID 生成。')
}

function stripCitationTokens(value: string) {
  return value.replace(/\[\[C\d+\]\]/gu, '')
}

function messageFor(error: unknown) {
  return error instanceof Error ? error.message : '请求未成功，请稍后重试'
}

function actionMessageFor(error: unknown) {
  if (!(error instanceof ApiError)) return messageFor(error)
  const messages: Record<string, string> = {
    ASSISTANT_MODEL_REQUIRED: '请先明确选择模型。',
    ASSISTANT_MODEL_UNAVAILABLE: '所选模型已不可用，请更换模型；草稿已保留。',
    ASSISTANT_REASONING_UNSUPPORTED: '所选思考档位已不可用，请重新选择。',
    ASSISTANT_IDEMPOTENCY_CONFLICT: '请求标识发生冲突，已停止自动发送；草稿已保留。',
    ASSISTANT_RUN_ALREADY_ACTIVE: '此会话已有回答正在运行。',
    ASSISTANT_SENSITIVE_INPUT_BLOCKED: '全局敏感策略阻止发送这条内容。',
    ASSISTANT_SENSITIVE_POLICY_CHANGED: '敏感策略已收紧；请按新策略手动重试。',
    ASSISTANT_CONTEXT_TOO_LARGE: '上下文过长，请缩短本轮内容后重试。',
    ASSISTANT_PROVIDER_CREDENTIALS_INVALID: 'Provider 凭据无效，请前往设置修正。',
    ASSISTANT_PROVIDER_UNAVAILABLE: 'Provider 暂时不可用；可更换模型后重试。',
    ASSISTANT_PROVIDER_PROTOCOL_ERROR: 'Provider 返回了不受支持的响应。',
    ASSISTANT_CITATION_INVALID: '回答包含无效引用，已按失败处理。',
  }
  return messages[error.code] ?? error.message
}

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === 'AbortError'
}

function reconnectDelay(signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal.aborted) return resolve()
    const timeout = window.setTimeout(resolve, 600)
    signal.addEventListener(
      'abort',
      () => {
        window.clearTimeout(timeout)
        resolve()
      },
      { once: true },
    )
  })
}
