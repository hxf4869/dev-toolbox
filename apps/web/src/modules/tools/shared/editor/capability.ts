import type { EditorCapabilityQuery, EditorKind } from './contracts'

export const DESKTOP_EDITOR_QUERY = '(min-width: 768px) and (pointer: fine)'

export function createEditorCapabilityQuery(): EditorCapabilityQuery {
  return window.matchMedia(DESKTOP_EDITOR_QUERY)
}

export function selectEditorKind(query: Pick<EditorCapabilityQuery, 'matches'>): EditorKind {
  return query.matches ? 'monaco' : 'codemirror'
}
