import { expect, mock, test } from 'claude-code/testing'

// A section is ~80+ characters so each paragraph stays its own section.
const para = (name: string) => `${name} ` + 'and the voice keeps on reading these words aloud '.repeat(2)
const reply = (...names: string[]) => names.map(para).join('\n\n')

const SPEECH_MS = 1000
const OK = { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
const BAR = {
  plugin: 'auto-voice',
  surface: 'desktop',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 4, bodyColumns: 120, scroll: { offset: 0, bodyRows: 4 }, view: {} },
} as const

// The world beneath the mod: a clock, and a `say` that "speaks" for SPEECH_MS unless pkill stops it.
function world(on: any, measureMs = 0) {
  const clock = mock.clock(on)
  const said: { text: string; voice: string | undefined }[] = []
  let playing: (() => void)[] = []
  let most = 0
  let answer = ''
  let index = 0

  on('process.run', async (_: unknown, e: any) => {
    const [cmd, ...args] = e.argv as string[]
    if (cmd === 'pkill') {
      const stopping = playing
      playing = []
      stopping.forEach(stop => stop())
      return { value: OK }
    }
    if (cmd === 'say' && !args.includes('-o')) {
      const v = args.indexOf('-v')
      said.push({ text: e.init?.stdin ?? '', voice: v >= 0 ? args[v + 1] : undefined })
      await new Promise<void>(done => {
        const stop = () => {
          playing = playing.filter(p => p !== stop)
          done()
        }
        playing.push(stop)
        most = Math.max(most, playing.length)
        void clock.sleep(SPEECH_MS).then(stop)
      })
      return { value: OK }
    }
    if (cmd === 'say' && measureMs > 0) await clock.sleep(measureMs)
    return { value: { ...OK, exitCode: 1 } } // measuring the sound fails here: the word estimate is used
  })
  on('ui.toast', () => ({ value: undefined }))
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

test('the voice button cycles voices and the next section uses it', async ($, on) => {
  const w = world(on)
  const ui = await $.ui.mount(BAR)
  expect(await label(ui, 'voice')).toBe('System default')
  await ui.press({ key: 'voice' })
  expect(await label(ui, 'voice')).toBe('Samantha')

  await $.turn.start({ text: 'one', turnId: 't1' })
  const s = w.step($, reply('A1'))
  await w.clock.advance(SPEECH_MS)
  await s.finished
  expect(w.said[0]?.voice).toBe('Samantha')

  for (let i = 0; i < 4; i += 1) await ui.press({ key: 'voice' })
  expect(await label(ui, 'voice')).toBe('System default')
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
