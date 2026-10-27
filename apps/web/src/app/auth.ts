import { computed, ref } from 'vue'
import { defineStore } from 'pinia'

import { ApiError, apiRequest, jsonRequest } from '../lib/api'

export type AuthStage =
  | 'checking'
  | 'anonymous'
  | 'mfa_required'
  | 'totp_setup'
  | 'recovery_codes'
  | 'authenticated'

interface Owner {
  id: string
  username: string
}

interface Session {
  id: string
  createdAt?: string
  lastSeenAt?: string
  expiresAt: string
  trustedDeviceId?: string | null
}

interface AuthenticatedResponse {
  status: 'authenticated'
  owner: Owner
  session: Session
  csrfToken: string
  recoveryCodes?: string[]
}

interface ChallengeResponse {
  status: 'mfa_required' | 'mfa_setup_required'
  challengeId: string
  expiresAt: string
}

export interface TOTPProvisioning {
  manualKey: string
  provisioningUri: string
  qrCodeDataUrl: string
}

export const useAuthStore = defineStore('auth', () => {
  const stage = ref<AuthStage>('checking')
  const owner = ref<Owner | null>(null)
  const session = ref<Session | null>(null)
  const csrfToken = ref('')
  const challengeId = ref('')
  const challengeExpiresAt = ref('')
  const provisioning = ref<TOTPProvisioning | null>(null)
  const recoveryCodes = ref<string[]>([])
  const enrollmentCanCancel = ref(false)
  const bootstrapError = ref('')

  const isAuthenticated = computed(() => stage.value === 'authenticated')

  function applyAuthenticated(response: AuthenticatedResponse) {
    owner.value = response.owner
    session.value = response.session
    csrfToken.value = response.csrfToken
    recoveryCodes.value = response.recoveryCodes ?? []
    challengeId.value = ''
    challengeExpiresAt.value = ''
    provisioning.value = null
    enrollmentCanCancel.value = false
    stage.value = recoveryCodes.value.length > 0 ? 'recovery_codes' : 'authenticated'
  }

  function clearAuthentication() {
    owner.value = null
    session.value = null
    csrfToken.value = ''
    challengeId.value = ''
    challengeExpiresAt.value = ''
    provisioning.value = null
    recoveryCodes.value = []
    enrollmentCanCancel.value = false
    stage.value = 'anonymous'
  }

  async function bootstrap() {
    stage.value = 'checking'
    bootstrapError.value = ''
    try {
      applyAuthenticated(await apiRequest<AuthenticatedResponse>('/api/v1/auth/session'))
    } catch (error) {
      clearAuthentication()
      if (!(error instanceof ApiError) || error.status !== 401) {
        bootstrapError.value = error instanceof Error ? error.message : '服务暂时不可用'
      }
    }
  }

  async function login(username: string, password: string) {
    const response = await apiRequest<AuthenticatedResponse | ChallengeResponse>(
      '/api/v1/auth/login',
      jsonRequest('POST', { username, password }),
    )
    if (response.status === 'authenticated') {
      applyAuthenticated(response)
      return
    }
    challengeId.value = response.challengeId
    challengeExpiresAt.value = response.expiresAt
    provisioning.value = null
    enrollmentCanCancel.value = false
    stage.value = response.status === 'mfa_required' ? 'mfa_required' : 'totp_setup'
  }

  async function loadTOTPProvisioning() {
    if (!challengeId.value) throw new Error('绑定挑战已失效，请重新登录')
    const response = await apiRequest<TOTPProvisioning>(
      '/api/v1/auth/totp/setup',
      jsonRequest('POST', { challengeId: challengeId.value }),
    )
    provisioning.value = response
    return response
  }

  async function verifySecondFactor(input: {
    method: 'totp' | 'recovery_code'
    code: string
    trustDevice: boolean
    deviceName: string
  }) {
    applyAuthenticated(
      await apiRequest<AuthenticatedResponse>(
        '/api/v1/auth/mfa/verify',
        jsonRequest('POST', { challengeId: challengeId.value, ...input }),
      ),
    )
  }

  async function confirmTOTP(code: string, trustDevice: boolean, deviceName: string) {
    applyAuthenticated(
      await apiRequest<AuthenticatedResponse>(
        '/api/v1/auth/totp/confirm',
        jsonRequest('POST', { challengeId: challengeId.value, code, trustDevice, deviceName }),
      ),
    )
  }

  async function beginTOTPReset(password: string, method: 'totp' | 'recovery_code', code: string) {
    const response = await apiRequest<ChallengeResponse>(
      '/api/v1/auth/totp/reset',
      jsonRequest('POST', { password, method, code }, csrfToken.value),
    )
    challengeId.value = response.challengeId
    challengeExpiresAt.value = response.expiresAt
    provisioning.value = null
    enrollmentCanCancel.value = true
    stage.value = 'totp_setup'
  }

  function cancelEnrollment() {
    if (!enrollmentCanCancel.value || !session.value) return
    challengeId.value = ''
    challengeExpiresAt.value = ''
    provisioning.value = null
    enrollmentCanCancel.value = false
    stage.value = 'authenticated'
  }

  async function regenerateRecoveryCodes(password: string, method: 'totp' | 'recovery_code', code: string) {
    const response = await apiRequest<{ recoveryCodes: string[] }>(
      '/api/v1/auth/totp/recovery-codes/regenerate',
      jsonRequest('POST', { password, method, code }, csrfToken.value),
    )
    recoveryCodes.value = response.recoveryCodes
    stage.value = 'recovery_codes'
  }

  async function logout(all = false) {
    if (!csrfToken.value) {
      clearAuthentication()
      return
    }
    const sessionId = session.value?.id
    try {
      await apiRequest<void>(
        all ? '/api/v1/auth/logout-all' : '/api/v1/auth/logout',
        jsonRequest('POST', {}, csrfToken.value),
      )
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 401 || error.code !== 'AUTH_REQUIRED') {
        throw error
      }
    }
    // 迟到的成功登出也不能清掉重新登录后的新会话：无论 204 还是
    // AUTH_REQUIRED，都只在会话仍是发起请求时的那个会话时才清理本地状态。
    if (session.value?.id !== sessionId) return
    clearAuthentication()
  }

  function acknowledgeRecoveryCodes() {
    recoveryCodes.value = []
    stage.value = session.value ? 'authenticated' : 'anonymous'
  }

  return {
    stage,
    owner,
    session,
    csrfToken,
    challengeExpiresAt,
    provisioning,
    recoveryCodes,
    enrollmentCanCancel,
    bootstrapError,
    isAuthenticated,
    bootstrap,
    login,
    loadTOTPProvisioning,
    verifySecondFactor,
    confirmTOTP,
    beginTOTPReset,
    cancelEnrollment,
    regenerateRecoveryCodes,
    logout,
    acknowledgeRecoveryCodes,
    clearAuthentication,
  }
})
