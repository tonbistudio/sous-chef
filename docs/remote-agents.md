# Agents on other computers

A Hermes running somewhere else (a VPS, a DGX Spark, a cloud agent) can edit the projects in the Sous Chef on your computer. Your computer still does the heavy work (transcription, previews, exports). The agent only gets small clips, frames and transcripts.

Everything is in **Settings (gear) → Remote agents → Set up…**.

## 1. Point a tunnel at Sous Chef

Turn on **Allow remote agents**. Sous Chef opens a separate door for agents at `http://127.0.0.1:47900`, on this computer only.

Point a tunnel at that address, for example Cloudflare Tunnel or Tailscale Funnel. Paste the tunnel's public address into **Its public address**, then press **Check**. Sous Chef calls itself through the tunnel and tells you if it got through.

While remote agents are allowed, Sous Chef keeps running in the background even with its window closed, so an agent can keep working.

## 2. Connect an agent

Give the agent a name (`vps`, `spark`…) and press **Make a key**. Sous Chef shows:

- a command to run on the agent's computer:
  ```
  hermes mcp add sous_chef --url https://<your tunnel>/mcp --auth header
  ```
- the key to paste when that command asks for one. It's shown only once; Sous Chef keeps only a fingerprint of it.

Restart Hermes on that computer. It now has Sous Chef's tools: it can list and open your projects, read transcripts, look at frames, cut, zoom, add text and graphics, write the YouTube description, and export.

Its edits show in your undo list as `vps: …` and can be undone like any other edit. **Remove** next to an agent cuts it off at once.

### What a remote agent can't do

It can't reach files outside your projects. It can't import files from disk, add reference videos by path, add pictures from disk as thumbnails, or export to a folder of its choosing (exports go to the project's exports folder). It can open any project in your projects folder.

To watch or listen to part of the video, it uses the `media_clip` tool. The tool returns a short mp3 or a small mp4 through a link that works for 15 minutes.

## 3. Optional: chat with it from Sous Chef

To have Sous Chef's chat panel (and the rough cut's questions) go to that agent instead of the Hermes on this computer:

1. On the agent's computer, turn on Hermes's API server by putting `API_SERVER_ENABLED=true` and an `API_SERVER_KEY` in its `.env`, then make it reachable over HTTPS.
2. In **Chat with it here**, tick the box and enter its address and API key. To use one of its profiles, add `/p/<profile>` to the address.
3. Press **Save and test**. Sous Chef checks both directions: that it can reach the agent, and that the agent can use Sous Chef's tools.

Voice (hold **V**, read replies aloud) still uses the Hermes on this computer.

## Notes

- The agent key travels only over your tunnel; use an HTTPS tunnel.
- The chat agent's API key is kept in `remote.json` in Sous Chef's home folder, never in projects.
- Your computer has to be on, with Sous Chef running, for a remote agent to edit.
