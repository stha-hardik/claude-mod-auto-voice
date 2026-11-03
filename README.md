# auto-voice

A Claude Code mod that reads Claude's replies aloud as they appear, so you never have to click a speaker button.

- Every message is read section by section, while Claude is still working.
- A small bar above the prompt: ♪ ⏮ ⏸/▶ ⏭, a section counter such as `2/3`, a row of dots that pulse with the voice, and the voice name.
- **⏮ / ⏭** move between sections of a reply, then on to the previous or next reply.
- **⏸ / ▶** pause and resume. Muting lasts one reply; your next message is read again. After a reply has finished, ▶ reads it again from the start.
- **Voice name** cycles through System default, Samantha, Karen, Daniel and Aman.

It uses your Mac's built-in voice, so it costs no tokens and sends nothing anywhere.

## Requirements

macOS (it uses the built-in `say` voice). The pulsing dots measure the voice with `python3`, which comes with Apple's command line tools; without it, the dots follow an estimate of the words instead.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install auto-voice --marketplace stha-hardik/claude-mod-auto-voice
```

From a shell:

```bash
claude plugin install auto-voice --marketplace stha-hardik/claude-mod-auto-voice
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `stha-hardik/claude-mod-auto-voice`, then Add plugin.

Answer `y` to add the marketplace, then pick the user scope so it works in every session.

## Settings

The starting voice can also be set in the config menu, under **auto-voice → Voice**.
