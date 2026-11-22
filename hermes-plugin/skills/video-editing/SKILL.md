---
name: video-editing
description: "Edit video in Sous Chef: read a project, cut, trim, split, reorder and restore clips, add zooms, look at frames, and undo. Use when the user asks to edit, trim, cut, tighten, zoom or review a video or take in Sous Chef."
version: 0.1.0
license: MIT
metadata:
  tags: "video, editing, sous-chef, timeline, youtube"
---

# Editing video in Sous Chef

Sous Chef is a local video editor. You edit through seven tools
(`mcp__sous_chef__project`, `transcript`, `edit_apply`, `suggest`, `frame_get`,
`history`, `render`). The user
watches the same project in the editor window, and your edits appear there
immediately, labelled as yours.

## Ground rules

- **Read before you edit.** Call `project` with `action: "get"` first. Use the
  ids and the revision it returns. Never invent a clip id, media id or time.
- **Times are whole microseconds.** 1 second = 1000000. 1:30 = 90000000.
- **Two clocks.** Timeline time is a position in the edited video. Source time
  is a position in a raw take. When the user says "cut from 0:10 to 0:12" they
  mean the timeline: use `timeline.cut`. Clip ops (`clip.trim`, `range.remove`)
  use source time.
- **One request, one step.** Put everything the user asked for into a single
  `edit_apply` call so it is one undo step. Write the `summary` the way you
  would describe it to them: "Cut the false start at 0:42".
- **Raw files are never changed.** Edits only change the project. Say so if the
  user worries about losing footage. Every cut can be restored.
- **Large removals need a yes first.** An edit that removes more than 20
  pieces or more than 30 seconds is not applied: `edit_apply` turns it into a
  suggestion the user accepts or rejects in the editor. Tell them it is waiting.
  Pass `approved: true` only when they already agreed to that exact removal.
- **After editing, report what changed** from the tool result: the new length
  and what was removed. Do not claim a result the tool did not return.

## Workflows

**Find the project.** `project` `list` shows what is open. If nothing is open,
ask which video, then `open` its `.sous` folder by path.

**Edit by the words.** This is the normal way to cut speech. `transcript`
`read` gives the spoken words in play order, each with an index, e.g.
`12:So 13:um 14:[pause 1.2s] 15:this`. To cut words 13 to 14, call `edit_apply`
with `{op: "words.remove", from: 13, to: 14}`. The pause around deleted words
goes with them and a short breath is left, so cuts do not sound clipped.
`{op: "words.restore", from, to}` brings words back. Indexes are only valid
for the revision you read them at: after any edit, read again. Use `search`
to find a phrase the user quotes. If there is no transcript yet, call
`transcribe`, poll `status` until the job is done, then read.

**Do the first pass.** When the user asks for a rough cut, a tidy-up, or to
"take out the dead air", call `suggest` with `action: "rough_cut"`. It works
out silences, filler words, repeated takes and zooms, and shows them to the
user as one suggestion with tick boxes. It needs a transcript first. Report the
summary and that it is waiting for them; do not accept it for them.

**Zooms.** For "add zooms" / "auto zoom", call `suggest` `rough_cut` with
`cuts: false`: it proposes zooms only (about one per 45 s at most), where the
user points with the mouse and where one part of the screen changes, without
replacing a rough cut that is waiting. To choose them yourself, `suggest`
`activity` lists those moments with a rectangle each (`kind` is `pointer` or
`change`). Read the transcript around them, look at one or two with
`frame_get`, and add zooms where the speech is about that part of the screen.
Leave space between zooms and keep each on screen long enough to read.

**Pacing.** To tighten pauses without a full rough cut ("tighten the pauses",
"it feels slow"), read the transcript: pauses show as `· 1.2s ·`. Put the cuts
up as a suggestion with `suggest` (kind `silence`, one `range.remove` per
pause, leaving about half a second) rather than applying them, unless the user
asked for it done. The user also has a Pacing view in the transcript panel
that does this in one click.

**Loudness.** `settings.set` `{audio:{normalize:true, targetLufs:-14}}` levels
the export: the whole video is measured and turned up or down by one amount,
with a limiter for peaks. -14 suits YouTube; -16 podcasts. The finished export
reports the loudness it reached (`loudnessLufs`).

**Captions and text.** Captions are made from the kept transcript words, so
fix misheard words with `word.fix` before turning them on with `settings.set`
(`captions.enabled: true`). For a title or a label, add a text overlay at a
timeline time. Keep text short and away from the caption area. To check the
look, render just that part with `render` `start`, `from_us` and `to_us`, and
read a frame of the result.

**Graphics.** For a name, a chapter break or a pointer at something on
screen, add a HyperFrames graphic: `lower-third`, `title-card`, `callout`,
`highlight` (a box drawn around part of the screen), `arrow`, `step`
(numbered walkthrough), `keys` (a keyboard shortcut), `counter`, `quote`,
`subscribe` and `end-card` (the last 10 s or so, for YouTube end screens).
Use them sparingly: one lower third when a person or tool is introduced, a
title card at a real change of topic, a highlight or arrow where the words
point at the screen. They take about half a minute each to render; if
`render` says graphics are still rendering, wait and try again.

**Transitions.** Between two main-track clips that touch, set
`transitionIn` on the later clip (`dissolve`, `wipe`, `slide`, `zoom`,
`white`, `black`, 0.3-1 s is usual). A plain cut is the default and right
for most cuts; use a transition at a change of topic or scene, not to hide
a flub cut inside a sentence.

**Cut a stretch out.** Read the project, then
`edit_apply` with `{op: "timeline.cut", startUs, endUs}`. The gap closes.

**Trim the start or end of a clip.** `{op: "clip.trim", clipId, sourceInUs}` or
`sourceOutUs`, in the take's own time (the clip's `sourceInUs`/`sourceOutUs`
from the project read tell you where it is now).

**Bring a cut back.** Each clip lists its `cuts` with ids:
`{op: "range.restore", clipId, rangeIds: [...]}`.

**Zoom in on something.** Look first with `frame_get`, choose the area, then
`{op: "zoom.add", mediaId, startUs, endUs, rect: [x, y, w, h]}`. The rect is
left, top, width, height as fractions of the picture (0 to 1) and the times are source time in that take.

**Check your work.** `frame_get` with `timeline_us` shows what now plays at a
point in the edit. Use it at a few decision points, not to browse.

**Export the video.** `render` with `action: "start"` returns a job id at
once. Poll `status` every few seconds until `state` is `done`, then give the
user the output path, size and how long it took. Never say an export finished
before `status` says so. Exports include cuts, zooms, captions, text and
graphics. Report `loudnessLufs` too when it is there.

**Undo.** `history` with `action: "undo"`. It reverts the most recent step,
whoever made it, so check the returned summary is the step you meant.

## When a call fails

- `stale_revision`: the user edited meanwhile. Read the project again and
  re-plan against the new state. Do not resend the old ops blindly.
- `not_found` / `invalid`: an id or time is wrong. Read the project again.
- "not set up on this computer": ask the user to open the Sous Chef app once.

## Timelines and free placement

- A project can hold several timelines; one is open at a time. `project` (action `get`) shows `timeline` (the open one) and `otherTimelines`. Every edit acts on the open timeline, so check it before editing when the user names a section.
- `timeline.add`, `timeline.switch`, `timeline.rename`, `timeline.remove`; `timeline.insert` copies another timeline's whole contents (clips, zooms, text, graphics, extra tracks) into the open one at `atUs`, moving later content right.
- Main-track clips sit at their own start time. Removing a clip leaves its space empty (it plays as black); `gap.close` closes one gap (`atUs`) or all of them. Do not close gaps the user left on purpose: they are often placeholders.
- Cutting words or ranges inside a clip still closes up by itself.

## Voiceover

- Voiceover clips sit on audio tracks and have their own transcripts. Captions follow the voiceover wherever it speaks, and a muted clip gets no captions.

## Reading the timeline

- `project` get starts with an `overview` line and a `tracks` list. Clips live on several tracks: the main track (detail in `mainClips`), voiceover, music, pictures and overlay video, detached audio. Check `tracks` before saying something is not there.
- A track marked `holds: "voiceover recordings"`, or a clip marked `voiceover: true`, is a voiceover. "Delete the voiceovers" means `clip.remove` for each of those clips (or `track.remove` for the track).
- `media.remove` takes an unused file out of the media bin; it never deletes the file.

## Flubbed lines

- The owner's main wish for a rough cut: where a line is said, fumbled, and said again, cut the first attempt cleanly and keep the clean take. Silences are trimmed only gently.
- `suggest` with `rough_cut` does this and waits for approval. When asked to do it by hand, read the transcript, remove the flubbed attempt by word index, and leave the pause around it.

## Memory and templates (shared across projects)

- A new chat starts with an `[Editor library]` block: your editor memory, the template list and recent projects. Use it; the owner makes many similar videos.
- Keep the memory current with `library` `memory_write` (rewrite the whole note, short bullet points). Add what the owner tells you or corrects about their style, recurring segments, and choices that worked. Never add secrets, tokens or account details.
- When the owner builds something they will reuse (an intro, a lower third, an outro, a picture-in-picture layout), offer to save it with `template_save` over the stretch it occupies, with a one-line description of when to use it. Insert templates with `template_insert` instead of rebuilding them.
- At the end of a session on a project, write one line with `project_note` (what the video is and what was done).

## Speed and framing

- `{op:'project.speed', speed}` sets the main track speed. New projects start at the speed in the owner's preferences.
- The main recording can be moved, resized and cropped like a picture: `clip.set` with `transform` on main clips.

## Publishing (thumbnail, title, description)

- The editor has a Publish view: the owner sees the picked thumbnail at full size and as it looks in the YouTube feed and sidebar, title options, and the description. Whatever you save with the `publish` tool shows there at once.
- Always start with `publish` `brief`. It has the owner's description template (follow it exactly; if it points to a file it was read fresh), thumbnail style and reference pictures, the finished length, named markers, and a timed outline. Outline times are in the finished video, after cuts and speed: use them for chapters as they are, never raw take times.
- If the owner has their own description or thumbnail skills, load and follow them as well; the brief's template wins where they differ only if the owner says so.
- Save with `publish` `set` (`title`, `titles` with 3-5 options, `description`). Do not paste the whole description into chat; say it is in the Publish view.
- Thumbnails: make the image with your image tools and save it in the project's `publish/thumbnails/` folder (it shows in the Publish view on its own), or `add_thumbnail` with the absolute path and a one-line note on what makes this option different. `grab_frame` gives a real screenshot from the edit to build on. Several options are better than one; the owner picks.
- An empty project is fine: the timeline can start with text, graphics or pictures, and media can be dragged in later.
