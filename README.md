# etc Speech (edge-tts-connector)

---

Local in-browser TTS reader (Linux-first) branded **etc Speech**. Uses the `edge-tts` library via a loopback daemon; the companion extension talks only to `127.0.0.1`.

### Status

- **Daemon (step 1):** `./server.sh start|stop` — see `project.md` / `daemon/`.
- **Extension shell (step 2):** `cd extension && npm i && npm run build` → load `extension/dist/chrome/` or `extension/dist/firefox/`. Options: paste secret + test connection. Popup: daemon health / secret status. Read path not wired yet.
- Specs: `AGENTS.md`, `project.md`, `spec/`.

### Why slop?

I consider this to be a perfect use case for LLMs: making a patchwork to connect two things together. Furthermore, I have no idea how long the edge-tts workarounds will continue to work in their current state, and so having an LLM write the main part of this in Python will aid in rapid updates.

I am not sure how well it will write a browser extension! We'll have to see. It's a little adventure.
