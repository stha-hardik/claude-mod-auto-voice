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
  props: { hasSurvey: false, isWorking: false, maxRows: 4, bodyColumns: 120, scroll: { offset: 0, bodyRows: 4 }, view: {} },
} as const

// The world beneath the mod: a clock, and a `say` that "speaks" for SPEECH_MS unless pkill stops it.
function world(on: any, measureMs = 0, speechMs = SPEECH_MS, voiceList = VOICE_LIST) {
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

test('the voice button offers System default and only natural English voices', async ($, on) => {
  const w = world(on)
  const ui = await $.ui.mount(BAR)
  expect(await label(ui, 'voice')).toBe('Voice: Default')
  const seen: string[] = []
  for (let i = 0; i < 5; i += 1) {
    await ui.press({ key: 'voice' })
    seen.push((await label(ui, 'voice')) ?? '')
  }
  // Robotic (Samantha, Zarvox) and non-English (Amélie) voices are left out; at most four are offered.
  expect(seen).toEqual(['Voice: Ava', 'Voice: Aman', 'Voice: Evan', 'Voice: Jamie', 'Voice: Default'])

  await ui.press({ key: 'voice' }) // Ava
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
  const keys = ['prev', 'next', 'toggle', 'toggle', 'voice']
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

test('with fewer than four natural voices, a one-time tip opens the voice settings', async ($, on) => {
  const w = world(on, 0, SPEECH_MS, FEW_VOICES)
  const ui = await $.ui.mount(BAR)
  await $.turn.start({ text: 'one', turnId: 't1' })
  expect(await label(ui, 'tip-get')).toBe('Get natural voices')
  await ui.press({ key: 'tip-get' })
  expect(w.opened).toEqual(['x-apple.systempreferences:com.apple.Accessibility-Settings.extension?SpokenContent'])
  expect(await ui.find({ key: 'tip-get' })).toBeUndefined()
  await ui.unmount()
})

test('the tip can be closed, and stays closed', async ($, on) => {
  const w = world(on, 0, SPEECH_MS, FEW_VOICES)
  const ui = await $.ui.mount(BAR)
  await $.turn.start({ text: 'one', turnId: 't1' })
  await ui.press({ key: 'tip-close' })
  expect(await ui.find({ key: 'tip-get' })).toBeUndefined()
  expect(w.opened).toEqual([])
  await ui.unmount()
})

test('with four natural voices there is no tip', async ($, on) => {
  world(on)
  const ui = await $.ui.mount(BAR)
  await $.turn.start({ text: 'one', turnId: 't1' })
  expect(await ui.find({ key: 'tip-get' })).toBeUndefined()
  await ui.unmount()
})

test('the bar draws on every surface', async ($, on) => {
  world(on)
  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...BAR, surface })
    expect(await label(ui, 'voice')).toBe('Voice: Default')
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
