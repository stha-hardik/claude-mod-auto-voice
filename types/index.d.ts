export type VoiceName = string

declare module 'claude-code' {
  interface PluginState {
    'auto-voice': {
      isPaused: boolean
      voice: VoiceName | null
      isSpeaking: boolean
      isActive: boolean
      marker: string
      isMuted: boolean
      isTipShown: boolean
    }
  }
}
