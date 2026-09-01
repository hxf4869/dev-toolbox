import { ref } from 'vue'
import { defineStore } from 'pinia'

import { useAuthStore } from '../../app/auth'
import { apiRequest, jsonRequest } from '../../lib/api'

export type Sensitivity = 'normal' | 'sensitive' | 'unknown'

export interface FolderEntry {
  id: string
  parentId: string | null
  name: string
  sortOrder: number
  itemCount: number
  children: FolderEntry[]
}

export interface TagEntry {
  id: string
  name: string
  itemCount: number
}

export interface AttachmentEntry {
  id: string
  kind: 'image' | 'file'
  originalName: string
  displayName: string
  clientMediaType?: string | null
  mediaType: string
  sizeBytes: number
  width?: number | null
  height?: number | null
  previewAllowed: boolean
  contentUrl: string
  thumbnailUrl?: string | null
  createdAt: string
}

export interface LibraryItem {
  id: string
  title: string
  sensitivity: Sensitivity
  favorite: boolean
  folderId?: string | null
  tags: TagEntry[]
  summary: string
  createdAt: string
  updatedAt: string
  deletedAt?: string | null
  effectiveCapturedAt: string
  sourceTimeQuality: string
  rawRecordCount: number
  attachmentCount: number
  attachments: AttachmentEntry[]
}

export interface SearchItem {
  itemId: string
  title: string
  snippetParts: Array<{ text: string; highlighted: boolean }>
  matchedSource: string
  matchedFragmentId: string
  effectiveCapturedAt: string
  sensitivity: Sensitivity
  artifactIsStale: boolean | null
}

export interface LibraryFilters {
  view?: string
  folderId?: string
  tagId?: string
  sort?: 'effective_desc' | 'updated_desc'
  contentKinds?: Array<'text' | 'image' | 'file' | 'mixed'>
  sensitivity?: Sensitivity[]
  from?: string
  to?: string
}

export function resolveLibraryView(view: unknown, folderId: unknown, tagId: unknown): string {
  const explicitView = typeof view === 'string' ? view.trim() : ''
  if (explicitView) return explicitView

  const hasFolder = typeof folderId === 'string' && folderId.trim() !== ''
  const hasTag = typeof tagId === 'string' && tagId.trim() !== ''
  return hasFolder || hasTag ? '' : 'inbox'
}

type ResultEntry =
  | { kind: 'library'; item: LibraryItem }
  | { kind: 'search'; item: SearchItem }

export const useLibraryStore = defineStore('library', () => {
  const auth = useAuthStore()
  const folders = ref<FolderEntry[]>([])
  const tags = ref<TagEntry[]>([])
  const results = ref<ResultEntry[]>([])
  const query = ref('')
  const mode = ref<'browse' | 'search'>('browse')
  const loading = ref(false)
  const navigationLoading = ref(false)
  const error = ref('')
  const total = ref<number | null>(null)
  const nextCursor = ref<string | null>(null)
  const managerOpen = ref(false)
  let lastAction: (() => Promise<void>) | null = null
  let resultController: AbortController | null = null
  let resultSequence = 0

  async function loadNavigation() {
    navigationLoading.value = true
    try {
      const [folderResponse, tagResponse] = await Promise.all([
        apiRequest<{ items: FolderEntry[] }>('/api/v1/folders/tree'),
        apiRequest<{ items: TagEntry[] }>('/api/v1/tags'),
      ])
      folders.value = folderResponse.items
      tags.value = tagResponse.items
    } finally {
      navigationLoading.value = false
    }
  }

  async function browse(filters: LibraryFilters, cursor?: string) {
    const action = async () => {
      const sequence = ++resultSequence
      resultController?.abort()
      const controller = new AbortController()
      resultController = controller
      loading.value = true
      error.value = ''
      try {
        const parameters = new URLSearchParams()
        if (filters.view) parameters.set('view', filters.view)
        if (filters.folderId) parameters.set('folderId', filters.folderId)
        if (filters.tagId) parameters.set('tagId', filters.tagId)
        if (filters.sort) parameters.set('sort', filters.sort)
        parameters.set('limit', '30')
        if (cursor) parameters.set('cursor', cursor)
        const response = await apiRequest<{ items: LibraryItem[]; nextCursor: string | null }>(
          `/api/v1/items?${parameters.toString()}`,
          { signal: controller.signal },
        )
        if (sequence !== resultSequence) return
        const entries = response.items.map((item) => ({ kind: 'library', item }) as const)
        results.value = cursor ? [...results.value, ...entries] : entries
        nextCursor.value = response.nextCursor
        total.value = null
        mode.value = 'browse'
      } catch (caught) {
        if (isAbortError(caught)) return
        error.value = caught instanceof Error ? caught.message : '资料库暂时不可用'
      } finally {
        if (sequence === resultSequence) loading.value = false
      }
    }
    lastAction = action
    await action()
  }

  async function search(filters: LibraryFilters, cursor?: string) {
    const searchText = query.value.trim()
    if (!searchText) {
      await browse(filters)
      return
    }
    const action = async () => {
      const sequence = ++resultSequence
      resultController?.abort()
      const controller = new AbortController()
      resultController = controller
      loading.value = true
      error.value = ''
      try {
        const request = jsonRequest(
          'POST',
          {
            q: searchText,
            sort: filters.sort === 'effective_desc' ? 'recency' : 'relevance',
            folderId: filters.folderId ?? null,
            tagIds: filters.tagId ? [filters.tagId] : [],
            contentKinds: filters.contentKinds ?? [],
            sensitivity: filters.sensitivity ?? [],
            from: filters.from ?? null,
            to: filters.to ?? null,
            cursor: cursor ?? null,
            limit: 30,
          },
          auth.csrfToken,
        )
        request.signal = controller.signal
        const response = await apiRequest<{
          total?: number
          items: SearchItem[]
          nextCursor: string | null
        }>('/api/v1/search', request)
        if (sequence !== resultSequence) return
        const entries = response.items.map((item) => ({ kind: 'search', item }) as const)
        results.value = cursor ? [...results.value, ...entries] : entries
        if (!cursor) total.value = response.total ?? response.items.length
        nextCursor.value = response.nextCursor
        mode.value = 'search'
      } catch (caught) {
        if (isAbortError(caught)) return
        error.value = caught instanceof Error ? caught.message : '搜索暂时不可用'
      } finally {
        if (sequence === resultSequence) loading.value = false
      }
    }
    lastAction = action
    await action()
  }

  function isAbortError(error: unknown) {
    return typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError'
  }

  async function retry() {
    if (lastAction) await lastAction()
  }

  function clearSearch() {
    query.value = ''
    mode.value = 'browse'
    total.value = null
  }

  async function createFolder(name: string, parentId: string | null) {
    await apiRequest(
      '/api/v1/folders',
      jsonRequest('POST', { name, parentId }, auth.csrfToken),
    )
    await loadNavigation()
  }

  async function renameFolder(id: string, name: string) {
    await apiRequest(
      `/api/v1/folders/${id}`,
      jsonRequest('PATCH', { name }, auth.csrfToken),
    )
    await loadNavigation()
  }

  async function moveFolder(id: string, parentId: string | null) {
    await apiRequest(
      `/api/v1/folders/${id}/move`,
      jsonRequest('POST', { parentId }, auth.csrfToken),
    )
    await loadNavigation()
  }

  async function deleteFolder(id: string) {
    await apiRequest(`/api/v1/folders/${id}`, jsonRequest('DELETE', {}, auth.csrfToken))
    await loadNavigation()
  }

  async function createTag(name: string) {
    await apiRequest('/api/v1/tags', jsonRequest('POST', { name }, auth.csrfToken))
    await loadNavigation()
  }

  async function renameTag(id: string, name: string) {
    await apiRequest(`/api/v1/tags/${id}`, jsonRequest('PATCH', { name }, auth.csrfToken))
    await loadNavigation()
  }

  async function deleteTag(id: string) {
    await apiRequest(`/api/v1/tags/${id}`, jsonRequest('DELETE', {}, auth.csrfToken))
    await loadNavigation()
  }

  return {
    folders,
    tags,
    results,
    query,
    mode,
    loading,
    navigationLoading,
    error,
    total,
    nextCursor,
    managerOpen,
    loadNavigation,
    browse,
    search,
    retry,
    clearSearch,
    createFolder,
    renameFolder,
    moveFolder,
    deleteFolder,
    createTag,
    renameTag,
    deleteTag,
  }
})
