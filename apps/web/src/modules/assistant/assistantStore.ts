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
  Reasoning,
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

const DRAFT_PREFIX = 'dev-toolbox:assistant:draft:'

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

  const selectedModelId = ref<UUID | null>(null)
  const selectedReasoning = ref<Reasoning>('off')
  const modelReasonings = reactive<Record<UUID, Reasoning>>({})

  const temporaryMode = ref(false)
  const temporaryMessages = ref<TemporaryMessageState[]>([])
  const temporarySummary = ref<TemporarySummaryDTO | null>(null)
  const temporaryContextStart = ref(0)
  const persistentDraft = ref('')
  const temporaryDraft = ref('')

  const persistentSources = reactive<Record<string, AssistantSourceDTO>>({})
  let observationController: AbortController | null = null
  let temporaryController: AbortController | null = null
  let persistentState: PersistentStreamState | null = null

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
    for (let index = messages.value.length - 1; index >= 0; index -= 1) {
      const run = messages.value[index]?.currentRun
      if (run?.status === 'queued' || run?.status === 'running') return run
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
    loading.value = true
    pageError.value = ''
    try {
      const [bootstrapResponse, folderResponse, conversationResponse] = await Promise.all([
        client().getBootstrap(),
        client().getFolders(),
        client().getConversations({ view: conversationView.value, limit: 30 }),
      ])
      bootstrap.value = bootstrapResponse
      folders.value = folderResponse.items
      conversations.value = conversationResponse.items
      conversationNextCursor.value = conversationResponse.nextCursor
      initializeSelections(bootstrapResponse)
      startNewConversation(false)
    } catch (error) {
      pageError.value = messageFor(error)
      if (bootstrap.value) actionError.value = pageError.value
    } finally {
      loading.value = false
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

  async function loadNavigation(append = false) {
    if (navigationLoading.value) return
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
      folders.value = folderResponse.items
      conversations.value = append
        ? mergeConversations(conversations.value, conversationResponse.items)
        : conversationResponse.items
      conversationNextCursor.value = conversationResponse.nextCursor
    } catch (error) {
      actionError.value = messageFor(error)
    } finally {
      navigationLoading.value = false
    }
  }

  async function setConversationView(value: 'active' | 'archived') {
    conversationView.value = value
    folderFilter.value = undefined
    conversationNextCursor.value = null
    await loadNavigation()
  }

  async function setFolderFilter(value: UUID | 'unfiled' | undefined) {
    folderFilter.value = value
    conversationNextCursor.value = null
    await loadNavigation()
  }

  function startNewConversation(focusDraft = true) {
    stopObservation()
    temporaryMode.value = false
    activeConversation.value = null
    messages.value = []
    messageNextCursor.value = null
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
    stopObservation()
    temporaryMode.value = true
    activeConversation.value = null
    messages.value = []
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

  async function selectConversation(conversation: AssistantConversationDTO) {
    if (conversationLoading.value) return
    stopObservation()
    temporaryMode.value = false
    activeConversation.value = conversation
    actionError.value = ''
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
      messages.value = response.items
      messageNextCursor.value = response.nextCursor
      const run = latestActiveRun(response.items)
      if (run) void observePersistentRun(run.id)
    } catch (error) {
      actionError.value = messageFor(error)
    } finally {
      conversationLoading.value = false
    }
  }

  async function loadOlderMessages() {
    if (!activeConversation.value || !messageNextCursor.value || conversationLoading.value) return
    conversationLoading.value = true
    try {
      const response = await client().getMessages(activeConversation.value.id, {
        before: messageNextCursor.value,
        limit: 30,
      })
      messages.value = mergeMessages(response.items, messages.value)
      messageNextCursor.value = response.nextCursor
    } catch (error) {
      actionError.value = messageFor(error)
    } finally {
      conversationLoading.value = false
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
    sending.value = true
    try {
      const response = await client().startRun({
        clientRequestId: createClientRequestId(),
        conversationId: activeConversation.value?.id ?? null,
        ...(!activeConversation.value
          ? { folderId: folderFilter.value && folderFilter.value !== 'unfiled' ? folderFilter.value : null }
          : {}),
        content,
        modelId: selectedModelId.value,
        reasoning: selectedReasoning.value,
      })
      activeConversation.value = response.conversation
      messages.value = mergeMessages(messages.value, [response.userMessage, response.assistantMessage])
      persistentDraft.value = ''
      removeDraft(draftKey)
      removeDraft(response.conversation.id)
      modelReasonings[selectedModelId.value] = selectedReasoning.value
      void loadNavigation()
      void observePersistentRun(response.run.id)
    } catch (error) {
      actionError.value = actionMessageFor(error)
    } finally {
      sending.value = false
    }
  }

  async function sendTemporary() {
    if (!selectedModelId.value || !selectedModel.value) return
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
          providerId: model.provider.id,
          providerDisplayName: model.provider.displayName,
        },
        reasoning: {
          reasoning: selectedReasoning.value,
          displayName: reasoningOption?.displayName ?? '不思考',
        },
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
    temporaryController = new AbortController()
    const initialDraft = temporaryDraft.value
    let accepted = false
    sending.value = true
    let streamState = createTemporaryStreamState()
    streamState.summary = temporarySummary.value
    try {
      const history = temporaryHistoryBefore(userId)
      for await (const envelope of client().streamTemporaryRun(
        {
          clientRequestId: requestId,
          modelId: selectedModelId.value,
          reasoning: selectedReasoning.value,
          summary: temporarySummary.value,
          messages: history,
          content,
        },
        temporaryController.signal,
      )) {
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
      if (!streamState.terminal) throw new Error('临时回答连接已中断。')
      if (streamState.status === 'succeeded' && streamState.summary !== temporarySummary.value) {
        temporarySummary.value = streamState.summary
        temporaryContextStart.value = Math.max(0, temporaryMessages.value.length - 16)
      }
    } catch (error) {
      if (!accepted && !isAbortError(error)) {
        temporaryMessages.value = temporaryMessages.value.filter(
          (message) => message.id !== userId && message.id !== assistantId,
        )
      } else if (!isAbortError(error)) {
        failTemporaryMessage(assistantId, messageFor(error))
      }
      if (!isAbortError(error)) actionError.value = messageFor(error)
    } finally {
      sending.value = false
      temporaryController = null
    }
  }

  async function stopActiveRun() {
    actionError.value = ''
    if (temporaryMode.value) {
      const message = activeTemporaryMessage.value
      temporaryController?.abort()
      if (message) {
        message.status = 'stopped'
        if (message.temporaryRuntime) {
          message.temporaryRuntime = {
            ...message.temporaryRuntime,
            status: 'stopped',
            phase: null,
          }
        }
      }
      return
    }
    const run = activePersistentRun.value
    if (!run || !run.canStop) return
    try {
      const updated = await client().stopRun(run.id)
      updateRunInMessages(updated)
      if (updated.status === 'stopped') stopObservation()
    } catch (error) {
      actionError.value = actionMessageFor(error)
    }
  }

  async function retryLastAnswer(runId: UUID) {
    actionError.value = ''
    if (!selectedModelId.value) {
      actionError.value = '请先选择重试使用的模型和思考档位。'
      return
    }
    if (hasActiveRun.value) return
    sending.value = true
    try {
      const response = await client().retryRun(runId, {
        clientRequestId: createClientRequestId(),
        modelId: selectedModelId.value,
        reasoning: selectedReasoning.value,
      })
      activeConversation.value = response.conversation
      messages.value = messages.value.map((message) =>
        message.id === response.assistantMessage.id ? response.assistantMessage : message,
      )
      void observePersistentRun(response.run.id)
    } catch (error) {
      actionError.value = actionMessageFor(error)
    } finally {
      sending.value = false
    }
  }

  async function observePersistentRun(runId: UUID) {
    stopObservation()
    observationController = new AbortController()
    const controller = observationController
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
        reconnecting.value = true
        streamMessage.value = '连接暂时中断，正在恢复回答…'
        if (error instanceof ApiError && error.status === 404) {
          actionError.value = error.message
          return
        }
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
    for (const [number, source] of Object.entries(state.sources)) {
      persistentSources[`${state.run.id}:${number}`] = source
    }
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
    const key = `${citation.runId}:${citation.citationNumber}`
    if (persistentSources[key]) return persistentSources[key]
    const source = await client().getSource(citation.runId, citation.citationNumber)
    persistentSources[key] = source
    return source
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
    temporaryController?.abort()
    temporaryController = null
    temporaryMessages.value = []
    temporarySummary.value = null
    temporaryContextStart.value = 0
    temporaryDraft.value = ''
  }

  function disposeView() {
    stopObservation()
    resetTemporaryConversation()
  }

  function stopObservation() {
    observationController?.abort()
    observationController = null
    persistentState = null
    reconnecting.value = false
    streamMessage.value = ''
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

  function updateRunInMessages(run: AssistantRunDTO) {
    const message = messages.value.find((entry) => entry.id === run.outputMessageId)
    if (!message) return
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

  function temporaryHistoryBefore(userId: string) {
    const cutoff = temporaryMessages.value.findIndex((entry) => entry.id === userId)
    return temporaryMessages.value
      .slice(temporaryContextStart.value, cutoff)
      .filter((message) =>
        message.status === 'complete' &&
        (message.role === 'user' || message.temporaryRuntime?.status === 'succeeded'),
      )
      .slice(-32)
      .map((message) => ({ role: message.role, content: stripCitationTokens(message.content) }))
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

function latestActiveRun(items: AssistantMessageDTO[]) {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const run = items[index]?.currentRun
    if (run?.status === 'queued' || run?.status === 'running') return run
  }
  return null
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
