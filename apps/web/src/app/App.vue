<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue'
import { isNavigationFailure, NavigationFailureType, useRouter } from 'vue-router'

import AppShell from '../components/shell/AppShell.vue'
import AuthView from '../modules/auth/AuthView.vue'
import { useAuthStore } from './auth'
import { useThemeStore } from './theme'
import { agentConsoleReturnPath } from './agentConsoleReturn'

const theme = useThemeStore()
const auth = useAuthStore()
const router = useRouter()

// 懒加载路由资源失败时保留当前页面，只给出同源完整加载入口；注册在常驻 App
// setup 上，首个导航失败（早于认证完成）也能被捕获，卸载时移除本组件的 hooks。
let latestIntentFullPath: string | null = null
const routeFailureHref = ref('')
const removeRouteHooks = [
  router.beforeEach((to) => {
    latestIntentFullPath = to.fullPath
  }),
  router.afterEach((to, _from, failure) => {
    // duplicated（重新点击当前页）由 router 上游结算且不经过 beforeEach，与成功导航一样
    // 把最新意图落在 to；aborted/cancelled 不算成功。
    if (failure && !isNavigationFailure(failure, NavigationFailureType.duplicated)) return
    latestIntentFullPath = to.fullPath
    routeFailureHref.value = ''
  }),
  router.onError((error, to) => {
    if (isNavigationFailure(error)) return
    // 较早失败的导航晚于新导航成功后才触发时，不得覆盖新页面或错误目标。
    if (latestIntentFullPath !== null && to.fullPath !== latestIntentFullPath) return
    routeFailureHref.value = `${window.location.origin}${to.fullPath}`
  }),
]

onUnmounted(() => {
  removeRouteHooks.forEach((remove) => remove())
})

onMounted(() => {
  theme.apply()
  void auth.bootstrap()
})

watch(
  () => auth.isAuthenticated,
  (authenticated) => {
    if (!authenticated) return
    const returnPath = agentConsoleReturnPath(
      new URLSearchParams(window.location.search).get('returnTo'),
      window.location.origin,
    )
    if (returnPath) window.location.replace(returnPath)
  },
)
</script>

<template>
  <AppShell v-if="auth.isAuthenticated" :route-failure-href="routeFailureHref" />
  <AuthView v-else />
</template>
