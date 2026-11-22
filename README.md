# Sous Chef

A local video editor where an AI agent does most of the edit. Built for long-form
screen recordings (tutorials, demos): the agent transcribes, cuts flubbed lines and
long silences, adds smooth zooms, captions and motion graphics, and writes the
YouTube title, description and thumbnail options. A full manual timeline is there
to fix whatever it got wrong.

![Sous Chef: agent chat, preview, transcript with a suggested rough cut, and the timeline](docs/screenshot.png)

Everything runs on your computer. Raw footage is never modified: a project points
at your takes and keeps its own files (cuts, transcripts, renders) in its folder.

**Status: v1.** The foundation works end to end and is used for real videos, but
expect rough edges. Windows is the main tested platform; macOS and Linux should
work but are less tested.

## Features

- **Transcript editing.** Delete words in the transcript to cut them; deleted words
  stay visible (struck through) so you can restore them.
- **Rough cut.** Finds flubbed lines (a line said, fumbled, then said again) by having
  the agent read the transcript, plus filler words and silences over 1.5 s. Every
  suggestion is a proposal you accept or reject.
- **Timeline.** Free-placement main track with gaps, snapping with a guide line,
  extra video and audio tracks, picture-in-picture, move/resize/crop on the preview,
  fades, speed (project-wide or per clip), markers, several timelines as tabs that
  can be dropped into each other, drag media from the list onto any track.
- **Smooth zooms** with eased in/out, pinned to moments in the recording.
- **Captions** (burned in or SRT), text, and HTML motion graphics rendered with
  [HyperFrames](https://www.npmjs.com/package/hyperframes).
- **Voiceover** recording at the playhead, with a noise reduction / compressor / EQ
  chain applied afterwards (the untouched recording is kept).
- **Export** with ffmpeg (NVENC when available), whole timeline or a range.
- **Agent chat** inside the editor, with pasted pictures, and a **Library** shared
  across projects: templates of timeline pieces, the agent's notes on how you edit,
  and a project log.
- **Publish view**: thumbnail options with a YouTube feed preview, title options and
  a description, written by the agent from your own description template.
- Every edit saves immediately, with undo history and autosave snapshots.

## How it fits together

| Package | What it is |
| --- | --- |
| `packages/core` | Project model, edit operations with undo, and the compiler that turns a project into the plan both preview and export read. No I/O. |
| `packages/server` | The edit server: owns project files, media, transcription, export, chat and the library. HTTP + WebSocket on `127.0.0.1` with a bearer token. |
| `packages/ui` | The editor (React), served by the edit server. |
| `packages/desktop` | Electron shell around the UI, with native file dialogs. |
| `packages/mcp` | Agent tools over MCP (stdio): `project`, `transcript`, `edit_apply`, `suggest`, `frame_get`, `history`, `render`, `library`, `publish`. |
| `hermes-plugin/` | A [Hermes Agent](https://github.com/NousResearch/hermes-agent) plugin: the MCP tools, an editing skill, and the editor as a page inside Hermes. |
| `sidecar/` | WhisperX transcription script (Python), run as a separate process. |

The desktop app, the Hermes page and the agent tools all talk to one shared edit
server, so an edit made by the agent shows up in the editor at once.

## Requirements

- Node.js 22+
- `ffmpeg` and `ffprobe` on `PATH`
- For transcription: Python 3.11 with WhisperX (see [`sidecar/README.md`](sidecar/README.md)).
  An NVIDIA GPU makes it practical; CPU works but is slow.
- For the agent features: [Hermes Agent](https://github.com/NousResearch/hermes-agent)
  installed and on `PATH` (the editor runs `hermes chat`; it stores no model keys
  itself). The manual editor works without it.
- For motion graphics: `npx` able to fetch `hyperframes` (Apache-2.0) on first use.

## Run it

```bash
npm install
npm run build
npm run desktop
```

`npm test` runs the test suite; `npm run typecheck` checks types.

### Hermes plugin

Link or copy `hermes-plugin/` into your Hermes plugins folder as `sous-chef`,
then enable it:

```bash
hermes plugins enable sous-chef
```

This adds the `sous_chef` tools and the `sous-chef:video-editing` skill.
Rebuild (`npm run build`) after changing the tools; a running Hermes picks up the
new tool list on its own.

In the editor's Chat tab you can pick which Hermes profile the editor talks to.

## Where things are kept

- **Projects** are folders ending in `.sous`. New projects go in
  `Documents/Sous Chef` unless you pick another folder.
- **App home**: `%LOCALAPPDATA%\sous-chef` on Windows,
  `~/.local/share/sous-chef` elsewhere, or `SOUS_CHEF_HOME`. It holds
  the server lock and token, `config.json` (sidecar Python path),
  `preferences.json`, and `library/` (templates, agent notes, project log,
  publishing templates).

## Settings via environment

| Variable | Use |
| --- | --- |
| `SOUS_CHEF_HOME` | App home folder |
| `SOUS_CHEF_PYTHON` | Python with WhisperX for transcription |
| `SOUS_CHEF_HERMES` | Hermes command (default `hermes`) |
| `SOUS_CHEF_HYPERFRAMES` | HyperFrames command override |

## Known limitations

- No installer yet; run from source.
- Cut audio is crossfaded and word edges are padded, but cuts are not perfect yet.
- Speech-to-text can drop "um"/"uh"; the editor adds unsure fillers it hears in pauses.
- Detaching audio ignores clip speed.
- The agent cannot watch or hear the video; it reads the transcript and grabs frames.

## Licence

MIT. See [LICENSE](LICENSE). Third-party tools it runs (ffmpeg, WhisperX,
HyperFrames, Hermes Agent) are separate programs under their own licences.
