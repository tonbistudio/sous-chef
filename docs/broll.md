# B-roll

The Library's **B-roll** section makes pictures and short clips to cut away to, and keeps
them for every project.

It has two makers side by side. Each has an **Image / Video** switch, a prompt and a
**Make** button, and runs at default settings:

| | On your machine | In the cloud |
| --- | --- | --- |
| Made by | [Imagination Studio](https://github.com/drowzeys/Imagination-Studio-by-keys-Wasserman), through its own job queue | Hermes Agent's `image_generate` / `video_generate` |
| Image | One picture at the Studio's default size and model | One 16:9 picture from the image provider set in your Hermes profile |
| Video | 5 seconds, 720p, the Studio's quick quality | The video provider's default length and resolution |
| Cost | Free, uses your GPU | Uses your provider's credits |

Finished items show in the shelf below the makers. **Insert at …** puts one on a video lane
over the open timeline at the playhead, as one undo step. **Again** makes another from the
same prompt.

For anything else (another model, size, length, quality or a starting picture), ask Hermes
in the chat. With the `imagination-studio` Hermes plugin it can drive the Studio directly
and bring the result into the project.

## Setting up Imagination Studio

1. Run Imagination Studio on this computer or on another machine you can reach.
2. In **Library → B-roll → On your machine**, click the address under the card.
3. Enter the Studio's address and its access key, then press **Save and check**. The key is
   in the Studio's Settings page, or in `~/ImaginationStudio/access-key` on its machine.

The default address is `http://127.0.0.1:7870`. For a Studio on another machine, use a
private address such as a Tailscale name. Sous Chef only sends the key over `https`, or
over plain `http` to a private address, and it never follows redirects.

The key is saved in Sous Chef's home folder and is never sent back to the page.

## The cloud side

There's nothing to set up in Sous Chef. It runs Hermes's own generation tools with the
Hermes profile chosen in Settings, so it uses the same providers, models and keys as Hermes
does anywhere else. Change them with `hermes tools` (Image Generation / Video Generation).

## Where the files go

Files are saved in `library/broll/` in Sous Chef's home folder and listed in
`library/broll.json`. Deleting an item from the shelf deletes its file, so projects that
used it will show it as missing.
