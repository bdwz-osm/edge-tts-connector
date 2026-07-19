# Bump manually when raising toolchain floors.
# Used by daemon/run.sh and rebuild_extensions.sh.

# uv installs this exact line; system python3 must be major.minor >= this.
PYTHON_VERSION=3.14

# Minimum Node.js version. Checked for --use-node,
# and as Bun's reported process.versions.node when using Bun.
NODE_VERSION=22.0.0
