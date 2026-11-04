import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

const isPaused = atom({ plugin: 'auto-voice', key: 'isPaused' } as const, false)
const voiceChoice = atom({ plugin: 'auto-voice', key: 'voice' } as const, null)
const isSpeaking = atom({ plugin: 'auto-voice', key: 'isSpeaking' } as const, false)
const isActive = atom({ plugin: 'auto-voice', key: 'isActive' } as const, false)
const marker = atom({ plugin: 'auto-voice', key: 'marker' } as const, '')
const isMuted = atom({ plugin: 'auto-voice', key: 'isMuted' } as const, false)
const isTipShown = atom({ plugin: 'auto-voice', key: 'isTipShown' } as const, false)

const VOICE_SETTINGS = 'x-apple.systempreferences:com.apple.Accessibility-Settings.extension?SpokenContent'
const TIP_KEY = 'voiceTipDismissed'

// System default, then up to four natural-sounding voices found on this Mac: Siri voices and the
// Premium or Enhanced ones from System Settings. The older robotic voices are left out.
const MAX_NATURAL = 4
let voices = ['System default']
let hasListed = false

const shortName = (voice: string) => voice.replace(/\s*\(.*\)\s*$/, '')

async function listVoices($: EngineInterface) {
  if (hasListed) return
  hasListed = true
  try {
    const out = await $.process.run(['say', '-v', '?'])
    const found: string[] = []
    for (const line of out.stdout.split('\n')) {
      const m = line.match(/^(.+?)\s+(en_[A-Z]+)\s+#(.*)$/)
      const name = m?.[1]?.trim()
      if (!name || found.includes(name)) continue
      if (/\((Premium|Enhanced)\)/.test(name) || /Siri/.test(m?.[3] ?? '')) found.push(name)
    }
    voices = ['System default', ...found.slice(0, MAX_NATURAL)]
  } catch {
    hasListed = false
  }
  const chosen = await read($, voiceChoice)
  if (chosen !== null && !voices.includes(chosen)) await update($, voiceChoice, () => null)
  const hasDismissed = await $.store.get(TIP_KEY).then(v => v === true, () => false)
  await update($, isTipShown, () => voices.length - 1 < MAX_NATURAL && !hasDismissed)
  if (!voices.includes(defaultVoice)) defaultVoice = 'System default'
}

const toSpeech = (text: string) =>
  text
    .replace(/```[\s\S]*?```/g, ' code omitted. ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' link ')
    .replace(/[#*_>|~-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

const DOTS = 62
const SPACING = 14
const WIDTH = DOTS * SPACING

type Loudness = { seconds: number; amps: number[] }

// Pulse dots. Each dot is one slice of the section's speech: it swells as its slice is spoken,
// by how loud that slice is, then settles, so the row draws the voice as it goes.
const waveSvg = (isOn: boolean, loud: Loudness | null) => {
  const dots = Array.from({ length: DOTS }, (_, i) => {
    const cx = SPACING / 2 + i * SPACING
    const base = '<circle cx="' + cx + '" cy="9.5" r="2" fill="#7c8cf8"'
    if (!isOn || !loud) return base + ' fill-opacity="0.4"/>'
    const bob = (8.2 - 0.9 * ((i % 4) / 3)).toFixed(1)
    const amp = loud.amps[i] ?? 0
    const start = i / DOTS
    const mid = start + 0.5 / DOTS
    const end = Math.min(start + 1 / DOTS, 0.9999)
    const peak = (2 + amp * 5.5).toFixed(2)
    const keep = (2 + amp * 3).toFixed(2)
    return (
      base + '><animate attributeName="cy" values="9.5;' + bob + ';9.5;' + (19 - Number(bob)).toFixed(1) + ';9.5" dur="1.2s" begin="' +
      ((i % 12) * 0.1).toFixed(1) + 's" repeatCount="indefinite"/><animate attributeName="r" values="2;2;' + peak + ';' + keep + ';' + keep +
      '" keyTimes="0;' + start.toFixed(4) + ';' + mid.toFixed(4) + ';' + end.toFixed(4) + ';1" dur="' +
      loud.seconds.toFixed(2) + 's" begin="0s" fill="freeze"/></circle>'
    )
  })
  return '<svg xmlns="http://www.w3.org/2000/svg" width="' + WIDTH + '" height="19" viewBox="0 0 ' + WIDTH + ' 19">' + dots.join('') + '</svg>'
}

const MEASURE = [
  'import wave,struct,sys',
  'w=wave.open(sys.argv[1]);n=w.getnframes();r=w.getframerate()',
  's=struct.unpack("<%dh"%n,w.readframes(n));k=int(r*0.05)',
  'e=[(sum(x*x for x in s[i:i+k])/k)**.5 for i in range(0,max(n-k,1),k)] or [0]',
  'N=int(sys.argv[2]);m=max(e) or 1;per=len(e)/N',
  'a=[max(e[int(i*per):max(int((i+1)*per),int(i*per)+1)] or [0])/m for i in range(N)]',
  'print(round(n/r,2),",".join(str(round(x**0.5,2)) for x in a))',
].join('\n')

// Splits a reply into sections at blank lines; short pieces join the one after them.
function splitSections(text: string): string[] {
  const parts = text
    .replace(/```[\s\S]*?```/g, ' code omitted. ')
    .split(/\n\s*\n/)
    .map(toSpeech)
    .filter(Boolean)
  const out: string[] = []
  let carry = ''
  for (const part of parts) {
    const joined = carry ? carry + ' ' + part : part
    if (joined.length < 80) carry = joined
    else {
      out.push(joined)
      carry = ''
    }
  }
  if (carry) {
    if (out.length > 0) out[out.length - 1] += ' ' + carry
    else out.push(carry)
  }
  return out
}

// Used when the sound cannot be measured: the dots still follow the words, estimated from their syllables.
function estimate(text: string): Loudness {
  const units: number[] = []
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const syllables = Math.max(1, (word.toLowerCase().match(/[aeiouy]+/g) ?? []).length)
    for (let k = 0; k < syllables; k += 1) units.push(k === 0 ? 1 : 0.65)
    if (/[.,;:!?]$/.test(word)) units.push(0, 0)
  }
  const amps = Array.from({ length: DOTS }, (_, i) => {
    const at = Math.min(units.length - 1, Math.floor((i / DOTS) * units.length))
    const unit = units[at] ?? 0
    return unit === 0 ? 0.05 : Math.min(1, unit * (0.7 + 0.3 * Math.abs(Math.sin(at * 1.7))))
  })
  return { seconds: Math.max(1, units.length * 0.21), amps }
}

// ---- The player ----
//
// One reader at a time reads sections aloud from the cursor onward. Every button and every new
// prompt bumps `gen`, which tells the running reader to stop, and kills the voice that is playing.
// Speech runs as our own `say` process, so stopping it is certain and nothing queues up behind it.

type Turn = { sections: string[]; isLive: boolean }

let defaultVoice = 'System default'
let loudness: Loudness | null = null
const turns: Turn[] = []
let live = -1 // the turn the model is working on now, or -1
let cursor = { turn: -1, section: 0 } // the section being read, or the next one to read
let gen = 0
let reader: Promise<void> | null = null
let readerGen = -1
let canRunSay = true // false once the host refuses to run `say`; $.audio.speak is used instead
const heard = new Set<string>() // messages of this turn already added, so the last one is not added twice

function lastSpoken(): number {
  for (let t = turns.length - 1; t >= 0; t -= 1) if ((turns[t]?.sections.length ?? 0) > 0) return t
  return -1
}

async function showState($: EngineInterface) {
  const sections = turns[cursor.turn]?.sections ?? []
  const shown = Math.min(cursor.section, sections.length - 1)
  await update($, marker, () => (sections.length > 0 ? `${shown + 1}/${sections.length}` : ''))
  await update($, isActive, () => reader !== null || turns[cursor.turn]?.isLive === true)
}

async function currentVoice($: EngineInterface): Promise<string | undefined> {
  const chosen = (await read($, voiceChoice)) ?? defaultVoice
  return chosen === 'System default' ? undefined : chosen
}

// Renders the section to a temporary sound file to measure how loud each moment is, for the wave.
// It takes a second or two, so it runs ahead, at low priority, while the section before is being spoken.
async function measure($: EngineInterface, text: string, voice: string | undefined): Promise<Loudness | null> {
  if (!canRunSay) return null
  fileCount += 1
  const id = String(await $.clock.now()) + '-' + fileCount
  const wav = '/tmp/auto-voice-' + id + '.wav'
  try {
    const toFile = ['-o', wav, '--file-format=WAVE', '--data-format=LEI16@8000', '-f', '-']
    const render = voice ? ['say', '-v', voice, ...toFile] : ['say', ...toFile]
    await $.process.run(['taskpolicy', '-c', 'background', ...render], { stdin: text, timeoutMs: 20000 })
    const out = await $.process.run(['python3', '-c', MEASURE, wav, String(DOTS)])
    const [seconds, list] = out.stdout.trim().split(' ')
    const amps = (list ?? '').split(',').map(Number)
    return amps.length === DOTS && Number(seconds) > 0 ? { seconds: Number(seconds), amps } : null
  } catch {
    return null
  } finally {
    await $.process.run(['rm', '-f', wav]).catch(() => {})
  }
}

let fileCount = 0
const measured = new Map<string, Loudness>()
const measuring = new Set<string>()

async function prepare($: EngineInterface, text: string | undefined, voice: string | undefined) {
  if (!text) return
  const key = (voice ?? '') + '|' + text
  if (measured.has(key) || measuring.has(key)) return
  measuring.add(key)
  const loud = await measure($, text, voice)
  measuring.delete(key)
  if (loud) measured.set(key, loud)
}

// Speaks one section and resolves when it has ended or been stopped.
async function speak($: EngineInterface, text: string, voice: string | undefined) {
  if (canRunSay) {
    try {
      const argv = voice ? ['say', '-v', voice, '-f', '-'] : ['say', '-f', '-']
      await $.process.run(argv, { stdin: text, timeoutMs: 600000 })
      return
    } catch {
      canRunSay = false
    }
  }
  await $.audio.speak(text, { voice }).catch(() => {})
}

async function silence($: EngineInterface) {
  if (canRunSay) await $.process.run(['pkill', '-x', 'say']).catch(() => {})
}

// Stops the voice for good: a reader that started its `say` just after the first stop is stopped again.
async function stopReading($: EngineInterface) {
  gen += 1
  await silence($)
  if (reader && readerGen !== gen) {
    await Promise.race([reader, $.clock.sleep(300)])
    if ((reader as Promise<void> | null) !== null && readerGen !== gen) await silence($)
  }
}

// Paused (this reply) or muted (the whole session): either way, nothing is read.
async function isQuiet($: EngineInterface): Promise<boolean> {
  return (await read($, isPaused)) || (await read($, isMuted))
}

async function readLoop($: EngineInterface, myGen: number) {
  try {
    await showState($)
    for (;;) {
      if (myGen !== gen || (await isQuiet($))) return
      const sections = turns[cursor.turn]?.sections ?? []
      if (cursor.section >= sections.length) return
      const text = sections[cursor.section] ?? ''
      await showState($)
      const voice = await currentVoice($)
      loudness = measured.get((voice ?? '') + '|' + text) ?? estimate(text)
      // Measure the next section a moment after this one starts: rendering sound while the voice
      // is starting makes it stutter, and two seconds in it no longer does (tested on every voice).
      const upcoming = sections[cursor.section + 1]
      const here = cursor
      $.clock.after(2000, () => {
        if (myGen === gen && cursor === here) void prepare($, upcoming, voice)
      })
      await update($, isSpeaking, () => true)
      if (myGen !== gen || (await isQuiet($))) return
      await speak($, text, voice)
      await update($, isSpeaking, () => false)
      if (myGen !== gen) return
      cursor = { turn: cursor.turn, section: cursor.section + 1 }
    }
  } finally {
    await update($, isSpeaking, () => false)
  }
}

// Reads from the cursor while `myGen` is current; waits out an older reader first.
async function pump($: EngineInterface, myGen: number) {
  while (reader) {
    if (myGen !== gen) return
    if (readerGen === gen) await reader
    else {
      // An older reader is still finishing: give it a moment, and silence it again if it is still talking.
      await Promise.race([reader, $.clock.sleep(400)])
      if (readerGen !== gen && (reader as Promise<void> | null) !== null) await silence($)
    }
  }
  if (myGen !== gen) return
  readerGen = myGen
  const mine = readLoop($, myGen)
  reader = mine
  try {
    await mine
  } finally {
    if (reader === mine) reader = null
    await showState($)
  }
}

// Stops whatever is being read and makes the cursor's section the next thing read.
async function jumpTo($: EngineInterface, turn: number, section: number) {
  gen += 1
  cursor = { turn, section }
  await update($, isPaused, () => false)
  await update($, isMuted, () => false) // pressing play, previous or next means: read this
  await silence($)
  await showState($)
  const myGen = gen
  $.clock.after(0, () => {
    void pump($, myGen)
  })
}

async function pressPrevious($: EngineInterface) {
  const sections = turns[cursor.turn]?.sections ?? []
  const shown = Math.min(cursor.section, sections.length - 1)
  if (shown > 0) return jumpTo($, cursor.turn, shown - 1)
  for (let t = cursor.turn - 1; t >= 0; t -= 1) if ((turns[t]?.sections.length ?? 0) > 0) return jumpTo($, t, 0)
  if (sections.length > 0) return jumpTo($, cursor.turn, 0)
}

async function pressNext($: EngineInterface) {
  const sections = turns[cursor.turn]?.sections ?? []
  const shown = Math.min(cursor.section, sections.length - 1)
  if (shown < sections.length - 1) return jumpTo($, cursor.turn, shown + 1)
  for (let t = cursor.turn + 1; t < turns.length; t += 1) if ((turns[t]?.sections.length ?? 0) > 0) return jumpTo($, t, 0)
  // The newest section of the newest turn: skip the rest of it.
  cursor = { turn: cursor.turn, section: sections.length }
  await stopReading($)
  await showState($)
}

async function pressPlayPause($: EngineInterface) {
  const quiet = await isQuiet($)
  const busy = reader !== null || turns[cursor.turn]?.isLive === true
  if (!quiet && busy) {
    await update($, isPaused, () => true)
    await stopReading($)
    await showState($)
    return
  }
  let turn = cursor.turn
  if ((turns[turn]?.sections.length ?? 0) === 0) turn = lastSpoken()
  const t = turns[turn]
  if (!t) return update($, isPaused, () => false)
  const isDone = !t.isLive && (turn !== cursor.turn || cursor.section >= t.sections.length)
  return jumpTo($, turn, isDone ? 0 : cursor.section)
}

// The session mute: stops this session's voice for good, across replies, until pressed again
// (or until play, previous or next is pressed). Other sessions keep talking.
async function pressMute($: EngineInterface) {
  const now = !(await read($, isMuted))
  await update($, isMuted, () => now)
  if (now) await stopReading($)
  await showState($)
}

async function dismissTip($: EngineInterface) {
  await $.store.set(TIP_KEY, true)
  await update($, isTipShown, () => false)
}

async function openVoiceSettings($: EngineInterface) {
  await $.process.run(['open', VOICE_SETTINGS]).catch(() => {})
  await dismissTip($)
}

let lastStatus: string | undefined

function showStatus($: EngineInterface, text: string | undefined) {
  if (text === lastStatus) return
  lastStatus = text
  $.ui.status(text)
}

async function pressVoice($: EngineInterface) {
  await listVoices($)
  const cur = (await read($, voiceChoice)) ?? defaultVoice
  const picked = voices[(voices.indexOf(cur) + 1) % voices.length] ?? 'System default'
  await update($, voiceChoice, () => picked)
}

function openTurn(): number {
  turns.push({ sections: [], isLive: true })
  live = turns.length - 1
  return live
}

// A new message from the model: its sections join the live turn and are read if the cursor is there.
async function addMessage($: EngineInterface, text: string) {
  if (live < 0) openTurn()
  heard.add(text)
  const sections = splitSections(text)
  if (sections.length === 0) return
  turns[live]?.sections.push(...sections)
  if (cursor.turn < 0) cursor = { turn: live, section: 0 }
  await showState($)
  if (cursor.turn === live && !(await isQuiet($))) await pump($, gen)
}

async function startTurn($: EngineInterface) {
  await listVoices($)
  const current = turns[live]
  if (current) current.isLive = false
  await stopReading($)
  const turn = openTurn()
  cursor = { turn, section: 0 }
  heard.clear()
  await update($, isPaused, () => false)
  await showState($)
}

async function endTurn($: EngineInterface, isAborted: boolean) {
  const current = turns[live]
  if (current) current.isLive = false
  live = -1
  if (isAborted) await stopReading($)
  await showState($)
}

export const register: Register = (on, options) => {
  defaultVoice = typeof options.voice === 'string' ? options.voice : 'System default'

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await listVoices($)
    return started
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) await startTurn($)
    return next(e)
  })

  // Each message the model writes, as soon as it is complete: read now, and the turn waits for it.
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    if (e.agentId === undefined && result.answer) {
      try {
        await addMessage($, result.answer)
      } catch (err) {
        $.ui.toast(`auto-voice: ${String(err).slice(0, 80)}`)
      }
    }
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined) {
      if (e.reason === 'answer' && result.text && !heard.has(result.text)) await addMessage($, result.text)
      await endTurn($, e.isAborted)
    }
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const paused = await read($, isPaused)
    const speaking = await read($, isSpeaking)
    const active = await read($, isActive)
    const voice = (await read($, voiceChoice)) ?? defaultVoice
    const position = await read($, marker)
    const muted = await read($, isMuted)
    const tip = await read($, isTipShown)
    const voiceLabel = `Voice: ${voice === 'System default' ? 'Default' : shortName(voice)}`

    // A question from Claude holds the band, so the bar steps aside; a line under the prompt keeps
    // showing what the voice is doing until the question is answered.
    if (e.props.hasSurvey) {
      const state = muted ? 'muted' : paused ? 'paused' : speaking ? 'reading' : 'ready'
      showStatus($, `${muted ? '🔇' : '🔊'} auto-voice · ${state}${position ? ' ' + position : ''} · ${voiceLabel}`)
      return next(e)
    }
    showStatus($, undefined)
    const table = $.ui.resolve(e)
    const { Box, Text, Button } = table
    const isOn = !paused && !muted && active

    return (
      <Box width="100%" alignItems="center">
        <Button key="mute" label={muted ? '🔇' : '🔊'} plain={true} onPress={() => pressMute($)} />
        <Text> </Text>
        <Button key="prev" label="⏮" onPress={() => pressPrevious($)} />
        <Text> </Text>
        <Button key="toggle" label={isOn ? '⏸' : '▶'} onPress={() => pressPlayPause($)} />
        <Text> </Text>
        <Button key="next" label="⏭" onPress={() => pressNext($)} />
        <Text dimColor> {position} </Text>
        <Box flexGrow={1} overflow="hidden">
          {'Svg' in table ? (
            <table.Svg source={waveSvg(speaking && !paused && !muted, loudness)} alt="Voice wave" width={WIDTH} height={19} isInteractive={true} />
          ) : (
            <Text dimColor>{speaking && !paused ? '●●●●●●●●' : '········'}</Text>
          )}
        </Box>
        {tip ? (
          <Box alignItems="center">
            <Button key="tip-get" label="Get natural voices" dimColor={true} onPress={() => openVoiceSettings($)} />
            <Button key="tip-close" label="×" plain={true} dimColor={true} onPress={() => dismissTip($)} />
            <Text> </Text>
          </Box>
        ) : (
          <Text> </Text>
        )}
        <Button key="voice" label={voiceLabel} onPress={() => pressVoice($)} />
      </Box>
    )
  })
}
