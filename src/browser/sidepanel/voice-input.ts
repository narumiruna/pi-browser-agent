export interface SpeechRecognitionAlternativeLike {
  transcript: string
}

export interface SpeechRecognitionResultLike {
  length: number
  item(index: number): SpeechRecognitionAlternativeLike | null
}

export interface SpeechRecognitionResultListLike {
  length: number
  item(index: number): SpeechRecognitionResultLike | null
}

export interface StopVoiceInputOptions {
  discardResults?: boolean
}

export interface SpeechRecognitionLike {
  continuous: boolean
  interimResults: boolean
  lang: string
  onresult: ((event: { results: SpeechRecognitionResultListLike }) => void) | null
  onerror: ((event: { error: string }) => void) | null
  onend: (() => void) | null
  start(): void
  stop(): void
  abort(): void
}

interface SpeechRecognitionConstructor {
  new (): SpeechRecognitionLike
}

interface SpeechRecognitionScope {
  SpeechRecognition?: SpeechRecognitionConstructor
  webkitSpeechRecognition?: SpeechRecognitionConstructor
}

interface VoiceInputCallbacks {
  onTranscript: (text: string) => void
  onListeningChange: (listening: boolean) => void
  onError: (error: Error) => void
}

type MicrophonePermissionQuery = (descriptor: {
  name: "microphone"
}) => Promise<{ state: PermissionState }>

type MicrophoneStreamRequest = (constraints: MediaStreamConstraints) => Promise<{
  getTracks(): Array<{ stop(): void }>
}>

export async function getMicrophonePermissionState(
  query: MicrophonePermissionQuery = (descriptor) =>
    navigator.permissions.query(descriptor as PermissionDescriptor),
): Promise<PermissionState> {
  return (await query({ name: "microphone" })).state
}

export async function requestMicrophoneAccess(
  getUserMedia: MicrophoneStreamRequest = (constraints) =>
    navigator.mediaDevices.getUserMedia(constraints),
): Promise<void> {
  const stream = await getUserMedia({ audio: true })
  for (const track of stream.getTracks()) track.stop()
}

function recognitionErrorMessage(code: string): string {
  switch (code) {
    case "not-allowed":
      return "Microphone access was denied. Allow microphone access for Pi Browser Agent and try again."
    case "service-not-allowed":
      return "Voice recognition is blocked by Chrome."
    case "audio-capture":
      return "No microphone is available."
    case "no-speech":
      return "No speech was detected."
    case "network":
      return "Voice recognition could not reach Chrome's speech service."
    default:
      return "Voice recognition stopped unexpectedly."
  }
}

function appendTranscript(existingText: string, transcript: string): string {
  const spokenText = transcript.trim()
  if (!spokenText) return existingText
  const separator = existingText.length === 0 || /\s$/.test(existingText) ? "" : " "
  return `${existingText}${separator}${spokenText}`
}

export class VoiceInputController {
  private baseText = ""
  private discardingResults = false
  private ignoringAbortError = false
  private stopping = false
  active = false

  constructor(
    private readonly recognition: SpeechRecognitionLike,
    private readonly callbacks: VoiceInputCallbacks,
    language: string,
  ) {
    recognition.continuous = true
    recognition.interimResults = true
    recognition.lang = language
    recognition.onresult = (event) => this.handleResult(event.results)
    recognition.onerror = (event) => this.handleError(event.error)
    recognition.onend = () => this.setActive(false)
  }

  toggle(existingText: string): void {
    if (this.active) this.stop()
    else this.start(existingText)
  }

  start(existingText: string): void {
    if (this.active) return
    this.baseText = existingText
    this.discardingResults = false
    this.ignoringAbortError = false
    this.stopping = false
    this.setActive(true)
    try {
      this.recognition.start()
    } catch (error) {
      this.setActive(false)
      this.callbacks.onError(
        error instanceof Error ? error : new Error("Voice recognition could not start."),
      )
    }
  }

  stop(options: StopVoiceInputOptions = {}): void {
    if (!this.active) return
    if (options.discardResults) this.discardingResults = true
    if (this.stopping) return
    this.stopping = true
    try {
      this.recognition.stop()
    } catch (error) {
      this.setActive(false)
      this.callbacks.onError(
        error instanceof Error ? error : new Error("Voice recognition could not stop."),
      )
    }
  }

  abort(): void {
    if (!this.active) return
    this.ignoringAbortError = true
    try {
      this.recognition.abort()
    } finally {
      this.setActive(false)
    }
  }

  private handleResult(results: SpeechRecognitionResultListLike): void {
    if (this.discardingResults) return
    let transcript = ""
    for (let index = 0; index < results.length; index += 1) {
      transcript += results.item(index)?.item(0)?.transcript ?? ""
    }
    this.callbacks.onTranscript(appendTranscript(this.baseText, transcript))
  }

  private handleError(code: string): void {
    this.setActive(false)
    if (code === "aborted" && this.ignoringAbortError) return
    this.callbacks.onError(new Error(recognitionErrorMessage(code)))
  }

  private setActive(active: boolean): void {
    if (this.active === active) return
    this.active = active
    if (!active) this.stopping = false
    this.callbacks.onListeningChange(active)
  }
}

export function createVoiceInput(
  callbacks: VoiceInputCallbacks,
  language = navigator.language,
  scope = globalThis as typeof globalThis & SpeechRecognitionScope,
): VoiceInputController | undefined {
  const Recognition = scope.SpeechRecognition ?? scope.webkitSpeechRecognition
  if (!Recognition) return undefined
  return new VoiceInputController(new Recognition(), callbacks, language)
}
