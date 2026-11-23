import type { ClientModule } from 'claude-code'

// The volume slider that takes the wave's place while the Volume button is open: it stretches from
// the section number to the Volume button, 5% at the left end and 100% right by the button. It
// moves in 5% steps and snaps to whole cells, so it is not touchy. Click a spot or drag the knob:
// the level is sent when the button comes up. Left and right arrows step it too.

type Props = { level: number } // 5 to 100
type State = { drag: number | null }

const STEP = 5
const snap = (level: number) => Math.max(STEP, Math.min(100, Math.round(level / STEP) * STEP))

const Slider: ClientModule<Props, State> = (props, surface) => {
  const { Box, Text } = surface.elements
  const cells = Math.max(10, surface.columns > 0 ? surface.columns : 40)
  const levelAt = (x: number) => snap(STEP + (x / (cells - 1)) * (100 - STEP))
  const saved = snap(typeof props?.level === 'number' ? props.level : 100)
  const drag = surface.state?.drag ?? null
  const level = drag ?? saved

  surface.onPointer(e => {
    if (e.type === 'down' && e.button === 'left') surface.setState({ drag: levelAt(e.x) })
    else if (e.type === 'move' && e.button === 'left' && drag !== null) {
      const next = levelAt(e.x)
      if (next !== drag) surface.setState({ drag: next })
    } else if (e.type === 'up' && drag !== null) {
      surface.post({ level: levelAt(e.x) })
      surface.setState({ drag: null })
    }
  })
  surface.onKey(e => {
    if (e.key === 'left' || e.key === 'down') surface.post({ level: snap(saved - STEP) })
    if (e.key === 'right' || e.key === 'up') surface.post({ level: snap(saved + STEP) })
  })

  // Laid out as shares of the slider's own width, never by counting glyphs (a surface may draw a
  // line glyph wider than a cell): the filled part takes the level's share, so 100% sits at the end.
  const knobShare = Math.min(20, 200 / cells) // the knob, about two cells, as a share of the width
  const filled = ((level - STEP) / (100 - STEP)) * (100 - knobShare)
  const line = (glyph: string) => glyph.repeat(cells * 2)
  // At 100% the filled part takes all the room the knob leaves, so the line ends at the knob.
  const isFull = level >= 100
  return (
    <Box flexDirection="row" width="100%" height={1} overflow="hidden">
      <Box
        width={isFull ? undefined : `${Math.round(filled)}%`}
        flexGrow={isFull ? 1 : 0}
        height={1}
        overflow="hidden"
        flexShrink={isFull ? 1 : 0}
      >
        <Text wrap="clip" color="#7c8cf8">{line('━')}</Text>
      </Box>
      <Text bold={true}>●</Text>
      {isFull ? null : (
        <Box flexGrow={1} height={1} overflow="hidden">
          <Text wrap="clip" dimColor={true}>{line('─')}</Text>
        </Box>
      )}
    </Box>
  )
}

export default Slider
