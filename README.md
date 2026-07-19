# etc Speech
*aka* `edge-tts-connector`, ETC

---

This is a WIP attempt to make an in-browser TTS reader (targeting Linux for now) using the edge-tts library. We have a local daemon as the go-between, which is supposed to communicate & coordinate with a "companion" browser extension using RPC.

### Usage

I've slopped together a basic prototype with a very extensive amount of yapping. You can probably get it up and running in your browser pretty quickly. 

Currently requires that you're on Linux (Windows maybe soon), and that you have Python & Node.js installed. Python is likely here to stay, though we might be able to support other Javascript runtimes.

Compile your browser extensions with `./rebuild-extensions.sh`. It provides instructions on how to add an extension from a folder on your machine.

Once you have the extension installed, get the daemon up and running with `./server.sh`. It'll show the secret, which you want to put into the options within the browser extension. Running it again will show the information. Running `./server.sh stop` will kill the server.

Starting the server will generate a `config.toml` in the same directory. It will contain your secret, as well as some other configurable options.

Using this system will generate cached audio clips in `tts-cache`. By default, the system will store up to **1 GB** of cached audio. Changing any of the generation settings will regenerate the clips to match them. You can change this in the config: `max_bytes` under `[cache]`.

### Why slop?

I consider this to be a perfect use case for LLMs: making a patchwork to connect two things together. Furthermore, I have no idea how long the edge-tts workarounds will continue to work in their current state, and so having an LLM write the main part of this in Python will aid in rapid updates.

I am not sure how well it will write a browser extension! We'll have to see. It's a little adventure.
