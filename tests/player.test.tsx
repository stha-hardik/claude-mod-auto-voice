import { expect, mock, test } from 'claude-code/testing'

// A section is ~80+ characters so each paragraph stays its own section.
const para = (name: string) => `${name} ` + 'and the voice keeps on reading these words aloud '.repeat(2)
const reply = (...names: string[]) => names.map(para).join('\n\n')

const SPEECH_MS = 1000
const VOICE_LIST = [
  'Samantha            en_US    # Hello! My name is Samantha.',
  'Ava (Premium)       en_US    # Hello! My name is Ava.',
  'Aman (English (India)) en_IN    # Hi, I’m Siri!',
  'Zarvox              en_US    # Hello! My name is Zarvox.',
  'Evan (Enhanced)     en_US    # Hello! My name is Evan.',
  'Amélie (Premium)    fr_CA    # Bonjour, je m’appelle Amélie.',
  'Jamie (Premium)     en_GB    # Hello! My name is Jamie.',
  'Zoe (Premium)       en_US    # Hello! My name is Zoe.',
].join('\n')
const OK = { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
const BAR = {
  plugin: 'auto-voice',
  surface: 'desktop',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 4, bodyColumns: 120, scroll: { offset: 0, bodyRows: 4 }, view: {} },
} as const

// The world beneath the mod: a clock, and a `say` that "speaks" for SPEECH_MS unless pkill stops it.
function world(on: any, measureMs = 0, speechMs = SPEECH_MS, voiceList = VOICE_LIST, ignoresVolm: string[] = []) {
  const files = new Map<string, { text: string; voice: string | undefined }>()
  const played: { text: string; voice: string | undefined; volume: string }[] = []
  const clock = mock.clock(on)
  mock.store(on)
  const opened: string[] = []
  const said: { text: string; voice: string | undefined }[] = []
  let playing: (() => void)[] = []
  let most = 0
  const renders: { at: number; speechAt: number }[] = []
  const speechStarts: number[] = []
  let answer = ''
  let index = 0

  on('process.run', async (_: unknown, e: any) => {
    const [cmd, ...args] = e.argv as string[]
    if (cmd === 'open') {
      opened.push(args[0] ?? '')
      return { value: OK }
    }
    if (cmd === 'pkill') {
      const stopping = playing
      playing = []
      stopping.forEach(stop => stop())
      return { value: OK }
    }
    if (cmd === 'say' && args[0] === '-v' && args[1] === '?') return { value: { ...OK, stdout: voiceList } }
    if (cmd === 'say' && !args.includes('-o')) {
      const v = args.indexOf('-v')
      said.push({ text: e.init?.stdin ?? '', voice: v >= 0 ? args[v + 1] : undefined })
      speechStarts.push(clock.now())
      await new Promise<void>(done => {
        const stop = () => {
          playing = playing.filter(p => p !== stop)
          done()
        }
        playing.push(stop)
        most = Math.max(most, playing.length)
        void clock.sleep(speechMs).then(stop)
      })
      return { value: OK }
    }
    // The volume probe: a few words rendered to a file, then measured. Voices named in `ignoresVolm`
    // come out just as loud with [[volm 0.2]] in front, as Siri voices do.
    if (cmd === 'say' && args.includes('-o')) {
      const v = args.indexOf('-v')
      files.set(args[args.indexOf('-o') + 1] ?? '', { text: e.init?.stdin ?? '', voice: v >= 0 ? args[v + 1] : undefined })
      return { value: OK }
    }
    if (cmd === 'python3' && args.length === 3) {
      const f = files.get(args[2] ?? '')
      const quiet = f?.text.startsWith('[[volm') && !ignoresVolm.includes(f.voice ?? '')
      return { value: { ...OK, stdout: quiet ? '200\n' : '1000\n' } }
    }
    if (cmd === 'afplay') {
      const f = files.get(args[2] ?? '')
      played.push({ text: f?.text ?? '', voice: f?.voice, volume: args[1] ?? '' })
      speechStarts.push(clock.now())
      await new Promise<void>(done => {
        const stop = () => {
          playing = playing.filter(p => p !== stop)
          done()
        }
        playing.push(stop)
        void clock.sleep(speechMs).then(stop)
      })
      return { value: OK }
    }
    if (cmd === 'taskpolicy') renders.push({ at: clock.now(), speechAt: speechStarts.at(-1) ?? -1 })
    if (cmd === 'taskpolicy' && measureMs > 0) await clock.sleep(measureMs)
    return { value: { ...OK, exitCode: 1 } } // measuring the sound fails here: the word estimate is used
  })
  const statuses: (string | undefined)[] = []
  on('ui.toast', () => ({ value: undefined }))
  on('ui.status', (_: unknown, e: any) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('turn.start', (_: unknown, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', (_: unknown, e: any) => ({ text: e.answer }))
  on('turn.step', async function* (_: unknown, e: any) {
    return { turnId: e.turnId, index: e.index, answer, toolUses: [], stopReason: 'end_turn', usage: null }
  })

  return {
    clock,
    said,
    played,
    texts: () => said.map(s => s.text.split(' ')[0]),
    isPlaying: () => playing.length > 0,
    most: () => most,
    statuses,
    opened,
    renders,
    // One model message; resolves when the turn may go on (after it was read, unless stopped).
    step: ($: any, text: string) => {
      answer = text
      const s = $.turn.step({ turnId: 't', index: index++, model: 'm', messageCount: 1 })
      let isDone = false
      const finished = (async () => {
        for await (const _ of s) void _
        await s.result
        isDone = true
      })()
      return { finished, isDone: () => isDone }
    },
  }
}

const label = async (ui: any, key: string) => (await ui.find({ key }))?.text
const name = async (ui: any, key: string) => (await ui.find({ key }))?.props.label
const markerText = async (ui: any) => (await ui.find({ type: 'Text', text: /^\s*\d+\/\d+\s*$/ }))?.text?.trim()

test('a live message is read section by section, and the turn waits for it', async ($, on) => {
  const w = world(on)
  const ui = await $.ui.mount(BAR)
  await $.turn.start({ text: 'hi', turnId: 't1' })

  const s = w.step($, reply('A1', 'A2', 'A3'))
  await w.clock.settle()
  expect(w.texts()).toEqual(['A1'])
  expect(await label(ui, 'toggle')).toBe('⏸')
  expect(await markerText(ui)).toBe('1/3')
  expect(s.isDone()).toBe(false)

  await w.clock.advance(SPEECH_MS)
  expect(w.texts()).toEqual(['A1', 'A2'])
  expect(await markerText(ui)).toBe('2/3')
  await w.clock.advance(SPEECH_MS)
  await w.clock.advance(SPEECH_MS)
  await s.finished
  expect(w.texts()).toEqual(['A1', 'A2', 'A3'])
  expect(w.most()).toBe(1)
  await ui.unmount()
})

test('pause stops the voice at once and nothing more is read; play resumes that section', async ($, on) => {
  const w = world(on)
  const ui = await $.ui.mount(BAR)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  const s = w.step($, reply('A1', 'A2', 'A3'))
  await w.clock.settle()
  await w.clock.advance(SPEECH_MS) // now reading A2

  await ui.press({ key: 'toggle' })
  await w.clock.settle()
  expect(w.isPlaying()).toBe(false)
  expect(await label(ui, 'toggle')).toBe('▶')
  await s.finished // the turn goes on while paused

  // Another message while paused: kept, not read.
  const s2 = w.step($, reply('B1'))
  await s2.finished
  await w.clock.advance(SPEECH_MS * 5)
  expect(w.texts()).toEqual(['A1', 'A2'])

  await ui.press({ key: 'toggle' })
  await w.clock.settle()
  expect(w.texts()).toEqual(['A1', 'A2', 'A2'])
  expect(await label(ui, 'toggle')).toBe('⏸')
  await w.clock.advance(SPEECH_MS)
  await w.clock.advance(SPEECH_MS)
  await w.clock.advance(SPEECH_MS)
  expect(w.texts()).toEqual(['A1', 'A2', 'A2', 'A3', 'B1'])
  expect(w.most()).toBe(1)
  await ui.unmount()
})

test('after a turn ends, play reads it again from its first section', async ($, on) => {
  const w = world(on)
  const ui = await $.ui.mount(BAR)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  const s = w.step($, reply('A1', 'A2'))
  await w.clock.advance(SPEECH_MS)
  await w.clock.advance(SPEECH_MS)
  await s.finished
  await $.turn.complete({ answer: reply('A1', 'A2'), durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  expect(await label(ui, 'toggle')).toBe('▶')
  expect(w.texts()).toEqual(['A1', 'A2']) // the final reply is not read twice

  await ui.press({ key: 'toggle' })
  await w.clock.settle()
  expect(w.texts()).toEqual(['A1', 'A2', 'A1'])
  expect(await markerText(ui)).toBe('1/2')
  await w.clock.advance(SPEECH_MS)
  await w.clock.advance(SPEECH_MS)
  expect(w.texts()).toEqual(['A1', 'A2', 'A1', 'A2'])
  expect(await label(ui, 'toggle')).toBe('▶')
  await ui.unmount()
})

test('next and previous move by section, then across turns', async ($, on) => {
  const w = world(on)
  const ui = await $.ui.mount(BAR)
  await $.turn.start({ text: 'one', turnId: 't1' })
  let s = w.step($, reply('A1', 'A2'))
  await w.clock.advance(SPEECH_MS * 2)
  await s.finished
  await $.turn.complete({ answer: reply('A1', 'A2'), durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await $.turn.start({ text: 'two', turnId: 't2' })
  s = w.step($, reply('B1', 'B2', 'B3'))
  await w.clock.advance(SPEECH_MS * 3)
  await s.finished
  await $.turn.complete({ answer: reply('B1', 'B2', 'B3'), durationMs: 1, isAborted: false, turnId: 't2', reason: 'answer' })
  w.said.length = 0

  // On B3 (the last one read). Previous: B2, then B1, then the previous turn's A1.
  await ui.press({ key: 'prev' })
  await w.clock.settle()
  expect(w.texts()).toEqual(['B2'])
  expect(await markerText(ui)).toBe('2/3')
  await ui.press({ key: 'prev' })
  await w.clock.settle()
  await ui.press({ key: 'prev' })
  await w.clock.settle()
  expect(w.texts()).toEqual(['B2', 'B1', 'A1'])
  expect(await markerText(ui)).toBe('1/2')

  // Next: A2, then over to the next turn's B1.
  await ui.press({ key: 'next' })
  await w.clock.settle()
  await ui.press({ key: 'next' })
  await w.clock.settle()
  expect(w.texts()).toEqual(['B2', 'B1', 'A1', 'A2', 'B1'])
  expect(await markerText(ui)).toBe('1/3')

  // Left alone, it reads to the end of that turn and stops there.
  await w.clock.advance(SPEECH_MS * 5)
  expect(w.texts()).toEqual(['B2', 'B1', 'A1', 'A2', 'B1', 'B2', 'B3'])
  expect(w.most()).toBe(1)
  await ui.unmount()
})

test('a new prompt stops an old replay and reads the new turn (never stuck on the old one)', async ($, on) => {
  const w = world(on)
  const ui = await $.ui.mount(BAR)
  await $.turn.start({ text: 'one', turnId: 't1' })
  const s = w.step($, reply('A1', 'A2', 'A3', 'A4', 'A5'))
  await w.clock.advance(SPEECH_MS * 5)
  await s.finished
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })

  await ui.press({ key: 'toggle' }) // replay A1…
  await w.clock.settle()
  await w.clock.advance(SPEECH_MS * 3) // …now on A4
  expect(await markerText(ui)).toBe('4/5')

  await $.turn.start({ text: 'two', turnId: 't2' })
  await w.clock.settle()
  expect(w.isPlaying()).toBe(false)
  const s2 = w.step($, reply('B1'))
  await w.clock.settle()
  expect(w.texts().at(-1)).toBe('B1')
  expect(await markerText(ui)).toBe('1/1')
  await w.clock.advance(SPEECH_MS * 5)
  await s2.finished
  expect(w.texts().filter(t => t === 'A5')).toEqual(['A5']) // the old replay never resumed
  expect(w.most()).toBe(1)
  await ui.unmount()
})

test('pausing lasts one turn: the next prompt reads again', async ($, on) => {
  const w = world(on)
  const ui = await $.ui.mount(BAR)
  await $.turn.start({ text: 'one', turnId: 't1' })
  const s = w.step($, reply('A1'))
  await w.clock.settle()
  await ui.press({ key: 'toggle' })
  await s.finished
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })

  await $.turn.start({ text: 'two', turnId: 't2' })
  const s2 = w.step($, reply('B1'))
  await w.clock.advance(SPEECH_MS)
  await s2.finished
  expect(w.texts()).toEqual(['A1', 'B1'])
  await ui.unmount()
})

test('next on the newest section skips it, and the turn goes on', async ($, on) => {
  const w = world(on)
  const ui = await $.ui.mount(BAR)
  await $.turn.start({ text: 'one', turnId: 't1' })
  const s = w.step($, reply('A1'))
  await w.clock.settle()
  await ui.press({ key: 'next' })
  await w.clock.settle()
  expect(w.isPlaying()).toBe(false)
  await s.finished
  const s2 = w.step($, reply('A2'))
  await w.clock.advance(SPEECH_MS)
  await s2.finished
  expect(w.texts()).toEqual(['A1', 'A2'])
  await ui.unmount()
})

const voiceNames = async (ui: any) => {
  const out: string[] = []
  for (let i = 0; i < 8; i += 1) {
    const b = await ui.find({ key: `voice-${i}` })
    if (b) out.push(b.props.label)
  }
  return out
}

test('the settings button opens the voices: System default and only natural English voices', async ($, on) => {
  const w = world(on)
  const ui = await $.ui.mount(BAR)
  expect(await ui.find({ key: 'voice-0' })).toBeUndefined()
  await ui.press({ key: 'settings' })
  // Robotic (Samantha, Zarvox) and non-English (Amélie) voices are left out; at most four are offered.
  expect(await voiceNames(ui)).toEqual(['✓ Default', 'Ava', 'Aman', 'Evan', 'Jamie'])
  await ui.press({ key: 'voice-1' }) // Ava
  expect(await voiceNames(ui)).toEqual(['Default', '✓ Ava', 'Aman', 'Evan', 'Jamie'])
  await ui.press({ key: 'settings' })
  expect(await ui.find({ key: 'voice-0' })).toBeUndefined()
  await $.turn.start({ text: 'one', turnId: 't1' })
  const s = w.step($, reply('A1'))
  await w.clock.advance(SPEECH_MS)
  await s.finished
  expect(w.said[0]?.voice).toBe('Ava (Premium)')
  await ui.unmount()
})

test('interrupting the turn (Esc) silences the voice', async ($, on) => {
  const w = world(on)
  await $.turn.start({ text: 'one', turnId: 't1' })
  const s = w.step($, reply('A1', 'A2'))
  await w.clock.settle()
  expect(w.isPlaying()).toBe(true)
  const done = $.turn.complete({ answer: '', durationMs: 1, isAborted: true, turnId: 't1', reason: 'aborted' })
  await w.clock.settle()
  await done
  await s.finished
  expect(w.isPlaying()).toBe(false)
  await w.clock.advance(SPEECH_MS * 3)
  expect(w.texts()).toEqual(['A1'])
})

test('speech starts at once, without waiting for the wave to be measured', async ($, on) => {
  const w = world(on, 1500)
  await $.turn.start({ text: 'one', turnId: 't1' })
  const s = w.step($, reply('A1', 'A2'))
  await w.clock.settle()
  expect(w.texts()).toEqual(['A1'])
  await w.clock.advance(SPEECH_MS)
  expect(w.texts()).toEqual(['A1', 'A2'])
  await w.clock.advance(SPEECH_MS * 3)
  await s.finished
  expect(w.most()).toBe(1)
})

test('mashing the buttons never plays two voices, and paused always means silent', async ($, on) => {
  const w = world(on, 50)
  const ui = await $.ui.mount(BAR)
  let seed = 7
  const rand = (n: number) => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed % n
  }
  const keys = ['prev', 'next', 'toggle', 'toggle', 'settings']
  for (let turn = 1; turn <= 3; turn += 1) {
    await $.turn.start({ text: 'p', turnId: 't' + turn })
    for (let m = 0; m < 3; m += 1) {
      const s = w.step($, reply('T' + turn + 'M' + m + 'a', 'T' + turn + 'M' + m + 'b'))
      for (let i = 0; i < 6; i += 1) {
        await ui.press({ key: keys[rand(keys.length)]! })
        await w.clock.advance(rand(3) * 400)
        if ((await label(ui, 'toggle')) === '▶') expect(w.isPlaying()).toBe(false)
      }
      await w.clock.advance(SPEECH_MS * 8)
      await s.finished
    }
    await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't' + turn, reason: 'answer' })
    await w.clock.advance(SPEECH_MS * 10)
    expect(w.isPlaying()).toBe(false)
    expect(await label(ui, 'toggle')).toBe('▶')
  }
  expect(w.most()).toBe(1)
  await ui.unmount()
})

test('the next section is measured only once the current one has been speaking for 2 seconds', async ($, on) => {
  const w = world(on, 100, 5000)
  await $.turn.start({ text: 'one', turnId: 't1' })
  const s = w.step($, reply('A1', 'A2', 'A3'))
  await w.clock.settle()
  expect(w.renders.length).toBe(0) // nothing renders while A1 starts
  await w.clock.advance(1900)
  expect(w.renders.length).toBe(0)
  for (let i = 0; i < 4; i += 1) await w.clock.advance(5000)
  await s.finished
  expect(w.renders.length).toBeGreaterThan(0)
  for (const r of w.renders) expect(r.at - r.speechAt).toBeGreaterThanOrEqual(2000)
})

test('a short section is not followed by a render that would land on the next start', async ($, on) => {
  const w = world(on, 100, 1000)
  await $.turn.start({ text: 'one', turnId: 't1' })
  const s = w.step($, reply('A1', 'A2', 'A3'))
  for (let i = 0; i < 5; i += 1) await w.clock.advance(1000)
  await s.finished
  expect(w.texts()).toEqual(['A1', 'A2', 'A3'])
  expect(w.renders.length).toBe(0)
})

test('the speaker button mutes this session across replies until pressed again', async ($, on) => {
  const w = world(on)
  const ui = await $.ui.mount(BAR)
  expect(await name(ui, 'mute')).toBe('🔊')
  await $.turn.start({ text: 'one', turnId: 't1' })
  const s = w.step($, reply('A1', 'A2'))
  await w.clock.settle()
  expect(w.isPlaying()).toBe(true)

  await ui.press({ key: 'mute' })
  await w.clock.settle()
  expect(w.isPlaying()).toBe(false)
  expect(await name(ui, 'mute')).toBe('🔇')
  expect(await label(ui, 'toggle')).toBe('▶')
  await s.finished
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })

  // Unlike pause, the mute survives a new prompt.
  await $.turn.start({ text: 'two', turnId: 't2' })
  const s2 = w.step($, reply('B1'))
  await w.clock.advance(SPEECH_MS * 3)
  await s2.finished
  expect(w.texts()).toEqual(['A1'])
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't2', reason: 'answer' })

  await ui.press({ key: 'mute' })
  expect(await name(ui, 'mute')).toBe('🔊')
  await $.turn.start({ text: 'three', turnId: 't3' })
  const s3 = w.step($, reply('C1'))
  await w.clock.advance(SPEECH_MS)
  await s3.finished
  expect(w.texts()).toEqual(['A1', 'C1'])
  await ui.unmount()
})

test('play while muted unmutes and reads', async ($, on) => {
  const w = world(on)
  const ui = await $.ui.mount(BAR)
  await ui.press({ key: 'mute' })
  await $.turn.start({ text: 'one', turnId: 't1' })
  const s = w.step($, reply('A1'))
  await s.finished
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  expect(w.said.length).toBe(0)
  await ui.press({ key: 'toggle' })
  await w.clock.settle()
  expect(w.texts()).toEqual(['A1'])
  expect(await name(ui, 'mute')).toBe('🔊')
  await ui.unmount()
})

const FEW_VOICES = ['Samantha            en_US    # Hello!', 'Aman (English (India)) en_IN    # Hi, I’m Siri!'].join('\n')

test('settings offer to get more voices, which opens the Mac voice settings', async ($, on) => {
  const w = world(on, 0, SPEECH_MS, FEW_VOICES)
  const ui = await $.ui.mount(BAR)
  await $.turn.start({ text: 'one', turnId: 't1' })
  await ui.press({ key: 'settings' })
  expect(await voiceNames(ui)).toEqual(['✓ Default', 'Aman'])
  expect(await label(ui, 'tip-get')).toBe('Get more voices')
  await ui.press({ key: 'tip-get' })
  expect(w.opened).toEqual(['x-apple.systempreferences:com.apple.Accessibility-Settings.extension?SpokenContent'])
  await ui.unmount()
})

test('the bar draws on every surface', async ($, on) => {
  world(on)
  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...BAR, surface })
    expect(await name(ui, 'settings')).toBe('⚙️')
    expect(await name(ui, 'volume-open')).toBe('Volume: 100%')
    expect(await name(ui, 'mute')).toBe('🔊')
    await ui.unmount()
  }
})

test('while Claude asks a question, the bar steps aside and a status line shows the voice', async ($, on) => {
  const w = world(on)
  const QUESTION = { ...BAR, props: { ...BAR.props, hasSurvey: true } }
  // Stands for the engine, which draws its question box when the mod steps aside.
  on('ui.render', ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    return <Text>Which image should I download?</Text>
  })
  const ui = await $.ui.mount(QUESTION)
  expect(await ui.find({ key: 'toggle' })).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: /Which image/ }))?.text).toBe('Which image should I download?')
  expect(w.statuses.at(-1)).toBe('🔊 auto-voice · ready · Voice: Default')

  await $.turn.start({ text: 'one', turnId: 't1' })
  const s = w.step($, reply('A1', 'A2'))
  await w.clock.settle()
  expect(w.texts()).toEqual(['A1']) // the voice keeps reading under a question
  expect(w.statuses.at(-1)).toBe('🔊 auto-voice · reading 1/2 · Voice: Default')
  await w.clock.advance(SPEECH_MS * 3)
  await s.finished
  await ui.unmount()

  // Question answered: the bar is back and the status line is cleared.
  const bar = await $.ui.mount(BAR)
  expect(await bar.find({ key: 'toggle' })).toBeDefined()
  expect(w.statuses.at(-1)).toBeUndefined()
  await bar.unmount()
})

// The slider fills the wave's place; laid out at 20 cells, cell 0 is 5% (its least), each cell 5%
// more, cell 19 is 100%.
const slide = async (ui: any, x: number) => {
  if (!(await ui.find({ key: 'volume-slider' }))) await ui.press({ key: 'volume-open' })
  await ui.resize({ columns: 20, rows: 1, in: 'volume-slider' })
  await ui.pointer({ type: 'down', x, y: 0, button: 'left', in: 'volume-slider' })
  await ui.pointer({ type: 'up', x, y: 0, button: 'left', in: 'volume-slider' })
}

test('the Volume button pops a slider out beside it; sliding sets the volume, the button closes it', async ($, on) => {
  const w = world(on)
  const ui = await $.ui.mount(BAR)
  expect(await name(ui, 'volume-open')).toBe('Volume: 100%')
  expect(await ui.find({ key: 'volume-slider' })).toBeUndefined()
  await ui.press({ key: 'volume-open' })
  expect(await ui.find({ key: 'volume-slider' })).toBeDefined()
  await slide(ui, 7) // 40%
  expect(await name(ui, 'volume-open')).toBe('Volume: 40%')
  expect(await name(ui, 'mute')).toBe('🔉')
  expect(await ui.find({ key: 'volume-slider' })).toBeDefined() // stays open to adjust again
  await ui.press({ key: 'volume-open' })
  expect(await ui.find({ key: 'volume-slider' })).toBeUndefined()
  await $.turn.start({ text: 'one', turnId: 't1' })
  const s = w.step($, reply('A1'))
  await w.clock.settle()
  expect(w.said.at(-1)?.text.startsWith('[[volm 0.40]] A1')).toBe(true)
  await w.clock.advance(SPEECH_MS)
  await s.finished
  await slide(ui, 1)
  expect(await name(ui, 'volume-open')).toBe('Volume: 10%')
  expect(await name(ui, 'mute')).toBe('🔈')
  await slide(ui, 40) // past the end: 100%
  expect(await name(ui, 'mute')).toBe('🔊')
  // A drag shows its step as it goes and sets the level when the button comes up.
  await ui.pointer({ type: 'down', x: 19, y: 0, button: 'left', in: 'volume-slider' })
  await ui.pointer({ type: 'move', x: 11, y: 0, button: 'left', in: 'volume-slider' })
  expect(await name(ui, 'volume-open')).toBe('Volume: 100%')
  await ui.pointer({ type: 'up', x: 11, y: 0, button: 'left', in: 'volume-slider' })
  expect(await name(ui, 'volume-open')).toBe('Volume: 60%')
  await ui.unmount()
})

test('where no slider can be drawn, the Volume button opens five dots instead', async ($, on) => {
  world(on)
  const ui = await $.ui.mount({ ...BAR, surface: 'vscode' })
  await ui.press({ key: 'volume-open' })
  await ui.press({ key: 'vol-2' })
  expect(await name(ui, 'volume-open')).toBe('Volume: 40%')
  expect(await ui.find({ key: 'vol-1' })).toBeUndefined()
  await ui.unmount()
})

test('one click on the speaker still mutes, and setting a volume unmutes', async ($, on) => {
  world(on)
  const ui = await $.ui.mount(BAR)
  await ui.press({ key: 'mute' })
  expect(await name(ui, 'mute')).toBe('🔇')
  expect(await name(ui, 'volume-open')).toBe('Volume: muted')
  await ui.press({ key: 'mute' })
  expect(await name(ui, 'mute')).toBe('🔊')
  await ui.press({ key: 'mute' })
  await slide(ui, 11)
  expect(await name(ui, 'mute')).toBe('🔉')
  expect(await name(ui, 'volume-open')).toBe('Volume: 60%')
  await ui.unmount()
})

test('changing the volume while it reads pauses 2 seconds, then goes on from a few words back', async ($, on) => {
  const w = world(on, 0, SPEECH_MS * 5)
  const ui = await $.ui.mount(BAR)
  await $.turn.start({ text: 'one', turnId: 't1' })
  const words = 'A1 one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen'
  w.step($, words + '\n\n' + para('A2'))
  await w.clock.settle()
  expect(w.said.length).toBe(1)
  // Its estimated length is about 7.4 seconds; stopped 3.7 seconds in, it had reached about halfway.
  await w.clock.advance(3700)
  await slide(ui, 11) // 60%
  await w.clock.settle()
  expect(w.isPlaying()).toBe(false)
  // Moving it again within the pause waits out that change too.
  await w.clock.advance(1500)
  await slide(ui, 11)
  await w.clock.advance(1500)
  expect(w.said.length).toBe(1)
  await w.clock.advance(600)
  await w.clock.settle()
  expect(w.said.length).toBe(2)
  const resumed = w.said.at(-1)?.text ?? ''
  expect(resumed.startsWith('[[volm 0.60]] ')).toBe(true)
  // One long sentence with no full stop: about halfway in, it goes back to its start.
  const first = resumed.replace('[[volm 0.60]] ', '').split(' ')[0]
  expect(first).toBe('A1')
  expect(resumed.endsWith('nineteen')).toBe(true)
  expect(w.most()).toBe(1)
  // The next section is read whole, at the volume.
  await w.clock.advance(SPEECH_MS * 5)
  await w.clock.settle()
  expect(w.said.at(-1)?.text.startsWith('[[volm 0.60]] A2')).toBe(true)
  // Previous goes back to the very start of a section.
  await ui.press({ key: 'prev' })
  await w.clock.settle()
  expect(w.said.at(-1)?.text.startsWith('[[volm 0.60]] A1 one')).toBe(true)
  await ui.unmount()
})

test('a Siri voice that ignores the volume in the text is played through afplay at the volume', async ($, on) => {
  const w = world(on, 0, SPEECH_MS, VOICE_LIST, ['Aman (English (India))'])
  const ui = await $.ui.mount(BAR)
  await ui.press({ key: 'settings' })
  await ui.press({ key: 'voice-2' }) // Default, Ava, Aman
  expect(await voiceNames(ui)).toContain('✓ Aman')
  await slide(ui, 7)
  await $.turn.start({ text: 'one', turnId: 't1' })
  const s = w.step($, reply('A1'))
  await w.clock.settle()
  expect(w.said.length).toBe(0)
  expect(w.played.at(-1)?.volume).toBe('0.40')
  expect(w.played.at(-1)?.text.startsWith('A1')).toBe(true)
  // Pause stops the afplay voice at once.
  await ui.press({ key: 'toggle' })
  await w.clock.settle()
  expect(w.isPlaying()).toBe(false)
  void s
  await ui.unmount()
})

test('Volume and settings open in the same place, so opening one closes the other', async ($, on) => {
  world(on)
  const ui = await $.ui.mount(BAR)
  await ui.press({ key: 'volume-open' })
  expect(await ui.find({ key: 'volume-slider' })).toBeDefined()
  await ui.press({ key: 'settings' })
  expect(await ui.find({ key: 'volume-slider' })).toBeUndefined()
  expect(await ui.find({ key: 'voice-0' })).toBeDefined()
  await ui.press({ key: 'volume-open' })
  expect(await ui.find({ key: 'voice-0' })).toBeUndefined()
  expect(await ui.find({ key: 'volume-slider' })).toBeDefined()
  await ui.unmount()
})

test('after a volume change it reads the sentence it stopped in again, from its start', async ($, on) => {
  const w = world(on, 0, SPEECH_MS * 5)
  const ui = await $.ui.mount(BAR)
  await $.turn.start({ text: 'one', turnId: 't1' })
  w.step($, 'A1 one two three. Four five six, seven eight nine ten eleven twelve. Thirteen fourteen fifteen sixteen seventeen eighteen.')
  await w.clock.settle()
  await w.clock.advance(4800)
  await slide(ui, 11)
  await w.clock.advance(2100)
  await w.clock.settle()
  expect(w.said.at(-1)?.text.startsWith('[[volm 0.60]] Four five six,')).toBe(true)
  await ui.unmount()
})

test('in a very long sentence it goes back a few words instead of to the far-off start', async ($, on) => {
  const w = world(on, 0, 60000)
  const ui = await $.ui.mount(BAR)
  await $.turn.start({ text: 'one', turnId: 't1' })
  const many = Array.from({ length: 60 }, (_, i) => `w${i}`).join(' ')
  w.step($, 'A1 ' + many)
  await w.clock.settle()
  await w.clock.advance(15000) // about two thirds of the way in
  await slide(ui, 11)
  await w.clock.advance(2100)
  await w.clock.settle()
  const first = (w.said.at(-1)?.text ?? '').replace('[[volm 0.60]] ', '').split(' ')[0] ?? ''
  const at = Number(first.slice(1))
  expect(first.startsWith('w')).toBe(true)
  expect(at).toBeGreaterThan(20)
  await ui.unmount()
})
