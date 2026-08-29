<script setup lang="ts">
import {
  BookOpen,
  Boxes,
  Check,
  ChevronLeft,
  CircleHelp,
  Folder,
  Inbox,
  Menu,
  Moon,
  Plus,
  Search,
  Settings,
  ShieldAlert,
  Sun,
  Wrench,
  X,
} from 'lucide-vue-next'
import { computed } from 'vue'

const props = withDefaults(
  defineProps<{
    name:
      | 'book-open'
      | 'boxes'
      | 'check'
      | 'chevron-left'
      | 'circle-help'
      | 'folder'
      | 'inbox'
      | 'menu'
      | 'moon'
      | 'plus'
      | 'search'
      | 'settings'
      | 'shield-alert'
      | 'sun'
      | 'wrench'
      | 'x'
    size?: number
  }>(),
  { size: 18 },
)

const icons = {
  'book-open': BookOpen,
  boxes: Boxes,
  check: Check,
  'chevron-left': ChevronLeft,
  'circle-help': CircleHelp,
  folder: Folder,
  inbox: Inbox,
  menu: Menu,
  moon: Moon,
  plus: Plus,
  search: Search,
  settings: Settings,
  'shield-alert': ShieldAlert,
  sun: Sun,
  wrench: Wrench,
  x: X,
} as const

const icon = computed(() => icons[props.name])
</script>

<template>
  <component :is="icon" :size="size" :stroke-width="1.8" aria-hidden="true" />
</template>
