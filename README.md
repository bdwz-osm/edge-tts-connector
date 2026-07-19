# edge-tts Connector

---

This is a WIP attempt to make an in-browser TTS reader (targeting Linux for now) using the edge-tts library. We have a local daemon as the go-between, which is supposed to communicate & coordinate with a "companion" browser extension using RPC.

### Status

Specification groundwork for the full system has been laid, you can see it in AGENTS.md, project.md, etc. Programming groundwork for the background daemon service has been laid in /daemon. Extension hasn't been written yet.

### Why slop?

I consider this to be a perfect usecase for LLMs: making a patchwork to connect two things together. Furthermore, I have idea how long the edge-tts workarounds will continue to work in their current state, and so having an LLM write the main part of this in Python will aid in rapid updates.

I am not sure how well it will write a browser extension! We'll have to see. It's a little adventure.
