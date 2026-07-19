# etc Speech
*or* `edge-tts-connector`, ETC

---

This is a **heavily WIP** attempt to make an in-browser TTS reader (targeting Linux for now) using the edge-tts Python library. We run a local service as the go-between, which is supposed to communicate & coordinate with a "companion" browser extension using RPC.

The result is that you get the page in your browser read block-by-block.

## Setup
Currently requires that you're on Mac or Linux (Windows scripts soon), 

You must have these two installed and in your PATH:
 - Python 3.14+, OR the `uv` toolchain (to run `./server.sh`)
   - Instructions for installing uv can be found [here](https://docs.astral.sh/uv/getting-started/installation/).) 
 - Node.js 22+, OR the `bun` toolchain  (to run `./rebuild_extensions.sh`)
   - Instructions for installing bun can be found [here](https://bun.com).)

Compile your browser extensions with `./rebuild_extensions.sh`. It compiles unpacked folders for each extension to the `./build` folder, and prints instructions on how to load an extension from a folder.

Once you have the extension installed, get the daemon up and running with `./server.sh`.
`./server.sh` will create a virtual environment in `daemon/venv` and run the server off of that.
 
By default, either script will prefer to use the toolchain if it's available. You can override this behavior using `./server.sh --use-python` or `./rebuild_extensions.sh --use-node`. 

If you tell `./server.sh` to use uv or Python **explicitly** after having installed the other way, it will regenerate `daemon/venv` and restart. 

`./server.sh` will show the secret, which you will need to give to the browser extension in its Options menu. Running `./server.sh` again will show the information. Running `./server.sh stop` will kill the server.

Starting the server will generate a `config.toml` in the same directory. It will contain your secret, as well as some other configurable options.

Using this system will generate cached audio clips in `tts-cache`. By default, the system will store up to **1 GB** of cached audio. Changing any of the generation settings will regenerate all audio clips to match them. You can change how big the cache will be in the config: `max_bytes` under `[cache]`.

## Usage Notes

The extension is likely going to have more difficulty parsing some pages more than others. However, on the pages I've tried, its rules somehow manage to actually find the content you want to read away from all the random clutter. But its current state, the reader will likely jump to some stupid stuff in the body.

## "Q&A"

Responses to questions I think some of you might ask.

### Privacy?

The text of the page being read is sent to Microsoft's text-to-speech servers, unproxied, with your IP address visible. However, the web request does not use your browser identity. Tracking ends up being very limited.

### Is it stable?

It's reasonably stable in my testing. I can't read all the code, it's very complex for something I just put down in a day. Most of the benefit comes from the thorough pre-outlining done in the pre-building stage, as well as the grilling I had the model do when it came to all the implementation details. I'm still going to keep working on it!

### Why slop?

I consider this to be a perfect use case for LLMs: making a patchwork to connect two things together. Furthermore, I have no idea how long the edge-tts workarounds will continue to work in their current state, and so having an LLM write the main part of this in Python will aid in rapid updates.

Harnesses, skills, etc. have also gotten really good in recent times, making a project like this more feasible.

The code was written using Grok 4.5 in OpenCode harness, and reviewed using CodeRabbit.
