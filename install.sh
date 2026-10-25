#!/usr/bin/env bash
# Install, refresh or undo imperfect and Files from this checkout of the imperfect repo.
#
#   ./install.sh           install, or bring an install up to this checkout
#   ./install.sh phone     show a QR code the phone's camera opens: it gets the
#                          Android app and joins it to this computer
#   ./install.sh undo      put the computer back the way it was (keeps ~/.imperfect)
#   ./install.sh update    fetch Locus's main and show what is new (merges nothing)
#
# Nothing here needs root. Every change is user-owned config, and each step
# prints how to reverse it. Run it again whenever the checkout changes: it only
# redoes what is out of date, and never restarts imperfect while an agent is working.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PREFIX="${IMPERFECT_PREFIX:-$HOME/.imperfect}"
PORT="${IMPERFECT_PORT:-5067}"
BIN_DIR="${IMPERFECT_BIN_DIR:-$HOME/.local/bin}"
SHARE="${XDG_DATA_HOME:-$HOME/.local/share}/imperfect-code"
CONFIG="${XDG_CONFIG_HOME:-$HOME/.config}"
UNIT_DIR="$CONFIG/systemd/user"
UNIT="imperfect-code.service"
MEMORY="imperfect-memory"
APPS="${XDG_DATA_HOME:-$HOME/.local/share}/applications"

say() { printf '\033[1m%s\033[0m\n' "$*"; }
note() { printf 'imperfect: %s\n' "$*" >&2; }
die() { note "$*"; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "need $1 on PATH"; }

# --- where this copy came from -----------------------------------------------
# Two kinds of copy. A store member's clone has their key in its URL
# (https://buyer:ic_…@host/imperfect.git): fetching updates needs nothing else,
# and downloads use the same key. A copy cloned from GitHub has no key and
# needs none: it fetches from GitHub, and downloads come from its releases.
RELEASES="https://github.com/locusrifle/imperfect/releases/download/binaries"
origin_url() { git -C "$ROOT" remote get-url origin 2>/dev/null || true; }
KEY="$(origin_url | sed -n 's|^https\?://[^/]*[:@]\(ic_[a-f0-9]\{40\}\)@.*|\1|p')"
[[ -n "$KEY" ]] || KEY="$(cat "$PREFIX/license" 2>/dev/null || true)"
BASE="$(origin_url | sed -n 's|^\(https\?://\)[^@/]*@\([^/]*\)/.*|\1\2|p')"

# --- what is new -------------------------------------------------------------
# One fetch brings Locus's main. Nothing is merged; the key and the address
# stay as they are.
update() {
  git -C "$ROOT" fetch --quiet --tags --prune origin
  say "new from locus since your checkout:"
  git -C "$ROOT" log --reverse --format='  %h %s' HEAD..origin/main
}

# A pinned file from binaries.json: download once, check the checksum, keep it.
# A store member downloads it from the store with their key; anyone else from
# GitHub's binaries release. Either way the same checksum must match.
fetch_pinned() { # <entry> -> prints the local path, or nothing
  local entry="$1" file sha dest url
  local -a auth=()
  [[ -f "$ROOT/binaries.json" ]] || return 0
  file="$(node -e 'const b=require(process.argv[1]);const e=b[process.argv[2]];if(e)process.stdout.write(e.file)' "$ROOT/binaries.json" "$entry")"
  sha="$(node -e 'const b=require(process.argv[1]);const e=b[process.argv[2]];if(e)process.stdout.write(e.sha256)' "$ROOT/binaries.json" "$entry")"
  [[ -n "$file" && -n "$sha" ]] || return 0
  dest="$SHARE/downloads/$file"
  if [[ ! -f "$dest" ]] || ! printf '%s  %s\n' "$sha" "$dest" | sha256sum -c --quiet - >/dev/null 2>&1; then
    if [[ -n "$KEY" && -n "$BASE" ]]; then url="$BASE/download/$file"; auth=(-u "buyer:$KEY")
    else url="$RELEASES/$file"; fi
    mkdir -p "$SHARE/downloads"
    curl -fsSL --retry 3 "${auth[@]}" -o "$dest.part" "$url" || { rm -f "$dest.part"; note "could not download $file"; return 0; }
    printf '%s  %s\n' "$sha" "$dest.part" | sha256sum -c --quiet - || { rm -f "$dest.part"; die "checksum failed for $file"; }
    mv "$dest.part" "$dest"
  fi
  printf '%s' "$dest"
}

# --- node ---------------------------------------------------------------------
node_ok() { command -v node >/dev/null 2>&1 && [[ "$(node -p 'Number(process.versions.node.split(".")[0])')" -ge 22 ]]; }
# Node 22 or newer. Without one, mise installs it for this checkout alone:
# the person's own default node is theirs, and is not changed.
ensure_node() {
  if ! node_ok && command -v mise >/dev/null 2>&1; then
    say "installing node 22 with mise"
    mise install node@22 >/dev/null
    export PATH="$(mise where node@22)/bin:$PATH"
  fi
  node_ok || die "need Node 22 or newer (install mise or node, then run this again)"
}

# The node binary itself for the service, never a version manager's shim: a
# shim resolves to the manager, which cannot run the server.
node_binary() {
  local found; found="$(command -v node)"
  if [[ "$found" == */shims/* ]] && command -v mise >/dev/null 2>&1; then found="$(mise which node)"; fi
  readlink -f "$found"
}

busy() {
  curl -fsS --max-time 3 "http://127.0.0.1:$PORT/health" 2>/dev/null \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).busy?"1":"0")}catch{process.stdout.write("0")}})'
}

# The mic's ears: Whisper large-v3-turbo on the GPU of the computer the others
# follow (the authority in machine.json, the PC). It stays loaded, in a
# service of its own on loopback, so restarting imperfect never unloads it;
# the other computers send it their recordings (system/transcribe.mjs).
# whisper.cpp is built here with Vulkan at a pinned commit. Anything the build
# lacks that needs no root (CMake, the Vulkan headers) is fetched, pinned,
# beside it in ~/.imperfect/whisper. Nothing leaves the person's computers.
WHISPER="imperfect-whisper.service"
WHISPER_COMMIT=4979e04f5dcaccb36057e059bbaed8a2f5288315 # v1.8.2
WHISPER_MODEL_URL=https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin
WHISPER_MODEL_SHA256=1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69
WHISPER_MODEL_BYTES=1624555275
CMAKE_VERSION=3.31.6
declare -A CMAKE_SHA256=(
  [x86_64]=5a1133ff103c71eb5120e2cc3de922733e7d8a26a98ae716397e8676adb367bf
  [aarch64]=b4cc788d63112b2749b40627e719eb5d3b8ed8f00c36d77189f4019cfe64bc9e
)
VULKAN_HEADERS_COMMIT=952f776f6573aafbb62ea717d871cd1d6816c387 # v1.4.309

# A repository at one commit, fetched shallow; the commit is its checksum.
git_at() { # <dir> <url> <commit>
  local dir="$1" url="$2" commit="$3"
  [[ "$(git -C "$dir" rev-parse HEAD 2>/dev/null)" == "$commit" ]] && return 0
  mkdir -p "$dir"
  git -C "$dir" init --quiet \
    && git -C "$dir" fetch --quiet --depth 1 "$url" "$commit" \
    && git -C "$dir" -c advice.detachedHead=false checkout --quiet --force FETCH_HEAD
}

# The Vulkan loader the build links to, where the distribution put it.
vulkan_library() {
  ls /usr/lib/libvulkan.so /usr/lib64/libvulkan.so /usr/lib/*-linux-gnu/libvulkan.so \
    /usr/lib/libvulkan.so.1 /usr/lib64/libvulkan.so.1 /usr/lib/*-linux-gnu/libvulkan.so.1 2>/dev/null | head -1 || true
}

# Whether the Vulkan headers are where a build finds them by itself.
vulkan_headers() { [[ -f /usr/include/vulkan/vulkan.h || -f /usr/local/include/vulkan/vulkan.h ]]; }

# whisper-server, built once for the pinned commit; WHISPER_SERVER is its path.
whisper_build() {
  local dir="$PREFIX/whisper" missing=() tool
  for tool in git c++ make glslc; do command -v "$tool" >/dev/null 2>&1 || missing+=("$tool"); done
  local lib; lib="$(vulkan_library)"
  [[ -n "$lib" ]] || missing+=(libvulkan)
  if (( ${#missing[@]} )); then
    note "the mic's ears need ${missing[*]} to build (a C++ compiler and make, shaderc for glslc, the Vulkan loader); install them with your package manager, then ./install.sh again"
    return 1
  fi
  local src="$dir/whisper.cpp" build="$dir/whisper.cpp/build"
  WHISPER_SERVER="$build/bin/whisper-server"
  [[ -x "$WHISPER_SERVER" && "$(cat "$build/.imperfect-built" 2>/dev/null)" == "$WHISPER_COMMIT" ]] && return 0

  local cmake=cmake
  if ! command -v cmake >/dev/null 2>&1; then
    local arch; arch="$(uname -m)"
    [[ -n "${CMAKE_SHA256[$arch]:-}" ]] || { note "no CMake for $arch is pinned here; install cmake, then ./install.sh again"; return 1; }
    cmake="$dir/cmake-$CMAKE_VERSION-linux-$arch/bin/cmake"
    if [[ ! -x "$cmake" ]]; then
      say "fetching CMake $CMAKE_VERSION for the build (Kitware's release, once)"
      mkdir -p "$dir"
      local tarball="$dir/cmake.tar.gz"
      if ! { curl -fL --progress-bar -o "$tarball" "https://github.com/Kitware/CMake/releases/download/v$CMAKE_VERSION/cmake-$CMAKE_VERSION-linux-$arch.tar.gz" \
          && printf '%s  %s\n' "${CMAKE_SHA256[$arch]}" "$tarball" | sha256sum -c --quiet - \
          && tar xzf "$tarball" -C "$dir"; }; then
        rm -f "$tarball"; note "could not fetch CMake, or it did not match its checksum"; return 1
      fi
      rm -f "$tarball"
    fi
  fi
  local headers=()
  if ! vulkan_headers; then
    say "fetching the Vulkan headers for the build (Khronos's v1.4.309, once)"
    git_at "$dir/vulkan-headers" https://github.com/KhronosGroup/Vulkan-Headers.git "$VULKAN_HEADERS_COMMIT" \
      || { note "could not fetch the Vulkan headers"; return 1; }
    headers=("-DVulkan_INCLUDE_DIR=$dir/vulkan-headers/include")
  fi

  say "building whisper.cpp with Vulkan for the mic (a few minutes, once)"
  git_at "$src" https://github.com/ggml-org/whisper.cpp.git "$WHISPER_COMMIT" || { note "could not fetch whisper.cpp"; return 1; }
  rm -rf "$build"
  if ! { "$cmake" -S "$src" -B "$build" -DGGML_VULKAN=ON -DWHISPER_BUILD_TESTS=OFF -DCMAKE_BUILD_TYPE=Release \
        "${headers[@]}" "-DVulkan_LIBRARY=$lib" >/dev/null \
      && "$cmake" --build "$build" --config Release --target whisper-server -j "$(nproc)" >/dev/null \
      && [[ -x "$WHISPER_SERVER" ]]; }; then
    note "whisper.cpp did not build; the output above says why"; return 1
  fi
  printf '%s\n' "$WHISPER_COMMIT" > "$build/.imperfect-built"
}

# The model, fetched once and checked; WHISPER_MODEL is its path.
whisper_model() {
  WHISPER_MODEL="$PREFIX/models/ggml-large-v3-turbo.bin"
  [[ "$(stat -c %s "$WHISPER_MODEL" 2>/dev/null)" == "$WHISPER_MODEL_BYTES" ]] && return 0
  say "fetching Whisper large-v3-turbo for the mic (1.6 GB, once)"
  mkdir -p "$PREFIX/models"
  if curl -fL --progress-bar -o "$WHISPER_MODEL.part" "$WHISPER_MODEL_URL" \
    && printf '%s  %s\n' "$WHISPER_MODEL_SHA256" "$WHISPER_MODEL.part" | sha256sum -c --quiet -; then
    mv "$WHISPER_MODEL.part" "$WHISPER_MODEL"
  else
    rm -f "$WHISPER_MODEL.part"
    note "Whisper's model could not be fetched, or did not match its checksum; ./install.sh again tries once more"
    return 1
  fi
}

# The unit that keeps Whisper loaded, on loopback at the port in machine.json.
whisper_unit() { # <port>
  cat <<EOF
[Unit]
Description=imperfect's ears: Whisper large-v3-turbo on the GPU (loopback :$1)

[Service]
Type=simple
ExecStart=$WHISPER_SERVER --host 127.0.0.1 --port $1 -m $WHISPER_MODEL -t 4 -bs 5 -bo 5 -l en -nc
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
EOF
}

# home: 0 when this is the computer the others follow (memory.mjs home), 1
# when it follows another, anything else when that cannot be told now.
whisper_ears() { # <node> <home>
  local node_bin="$1" home="$2"
  # The mic's model before Whisper is not used any more.
  rm -rf "$PREFIX/models/parakeet-tdt-0.6b-v2-int8"
  if [[ "$home" != 0 ]]; then
    if [[ "$home" == 1 && -f "$UNIT_DIR/$WHISPER" ]]; then
      systemctl --user disable --now "$WHISPER" >/dev/null 2>&1 || true
      rm -f "$UNIT_DIR/$WHISPER"
      systemctl --user daemon-reload
    fi
    return 0
  fi
  # The person's own words for Whisper (names, places), one per line: theirs to fill.
  [[ -e "$PREFIX/vocabulary.txt" ]] || (umask 077; : > "$PREFIX/vocabulary.txt")
  command -v ffmpeg >/dev/null 2>&1 || say "note: ffmpeg is not installed, so the mic cannot hear recordings until it is"
  whisper_build || return 0
  whisper_model || return 0
  local port unit
  port="$("$node_bin" --input-type=module -e "import { readConfig } from '$ROOT/system/machine.mjs'; process.stdout.write(String((await readConfig(process.argv[1])).whisper.port))" "$PREFIX")"
  unit="$(whisper_unit "$port")"
  mkdir -p "$UNIT_DIR"
  # Restarted only when it changed: loading takes a moment, and a recording
  # may be being heard.
  if [[ "$(cat "$UNIT_DIR/$WHISPER" 2>/dev/null)" != "$unit" ]]; then
    printf '%s\n' "$unit" > "$UNIT_DIR/$WHISPER"
    systemctl --user daemon-reload
    systemctl --user enable "$WHISPER" >/dev/null 2>&1 || true
    systemctl --user restart "$WHISPER"
    say "the mic's ears are running: Whisper on the GPU, loopback :$port ($WHISPER)"
  else
    systemctl --user enable --now "$WHISPER" >/dev/null 2>&1 || true
  fi
}

# Memory: every session's log from every computer, kept in one place, and the
# whole thread made from them day by day, on the computer the others follow
# (the authority in machine.json), or on this one when it follows none
# (system/memory.mjs). A timer runs a pass there every two minutes, so
# recent.md (the last two days, for an agent to read first) holds what was
# said a few minutes ago, and a model writes up each stretch of a session
# that has ended; every two hours the pass then brings Pi and Claude Code up
# to date. A computer that follows another keeps none.
memory_timer() { # <node> <home>
  local node_bin="$1" home="$2"
  if [[ "$home" == 0 ]]; then
    cat > "$UNIT_DIR/$MEMORY.service" <<EOF
[Unit]
Description=imperfect memory: every session's log, and the episodes, days, projects and recent.md made from them

[Service]
Type=oneshot
WorkingDirectory=$ROOT
Environment=PATH=$(dirname "$node_bin"):/usr/local/bin:/usr/bin
Environment=IMPERFECT_PREFIX=$PREFIX
ExecStart=$node_bin $ROOT/system/memory.mjs
Nice=10
EOF
    cat > "$UNIT_DIR/$MEMORY.timer" <<EOF
[Unit]
Description=imperfect memory, every two minutes

[Timer]
OnCalendar=*:0/2
AccuracySec=1s
Persistent=true

[Install]
WantedBy=timers.target
EOF
    systemctl --user daemon-reload
    systemctl --user enable --now "$MEMORY.timer" >/dev/null 2>&1 || true
  elif [[ "$home" == 1 && -f "$UNIT_DIR/$MEMORY.timer" ]]; then
    systemctl --user disable --now "$MEMORY.timer" >/dev/null 2>&1 || true
    rm -f "$UNIT_DIR/$MEMORY.timer" "$UNIT_DIR/$MEMORY.service"
    systemctl --user daemon-reload
  fi
}

setup() {
  need git; need curl; need sha256sum; need systemctl
  ensure_node
  local node_bin; node_bin="$(node_binary)"
  [[ "$("$node_bin" --version 2>/dev/null)" == v* ]] || die "could not find the node binary itself (found $node_bin)"

  # Dependencies, only when the lockfile changed since the last install.
  local lock_sum; lock_sum="$(sha256sum "$ROOT/package-lock.json" | cut -d' ' -f1)"
  if [[ "$(cat "$ROOT/node_modules/.imperfect-lock" 2>/dev/null)" != "$lock_sum" ]]; then
    say "installing dependencies (npm ci)"
    (cd "$ROOT" && npm ci --no-audit --no-fund --loglevel=error)
    printf '%s\n' "$lock_sum" > "$ROOT/node_modules/.imperfect-lock"
  fi

  # Personal state lives in ~/.imperfect, outside this checkout.
  mkdir -p "$PREFIX" "$BIN_DIR"
  chmod 700 "$PREFIX"
  if [[ -n "$KEY" ]]; then (umask 077; printf '%s\n' "$KEY" > "$PREFIX/license"); fi
  if [[ ! -f "$PREFIX/machine.json" ]]; then
    (umask 077; printf '{\n  "port": %s,\n  "origins": [],\n  "authentication": true\n}\n' "$PORT" > "$PREFIX/machine.json")
    say "wrote $PREFIX/machine.json"
  fi
  # What the agents are told is the person's own ~/AGENTS.md, which Claude and
  # Pi both read; imperfect adds nothing to their prompts. A computer with no
  # instructions of its own starts with this one line, theirs to change.
  if [[ ! -e "$HOME/AGENTS.md" && ! -e "$HOME/CLAUDE.md" ]]; then
    printf '%s\n' '# For the agents on this computer' '' \
      'Each new creation gets its own folder in ~/workbench. When I want to keep something, make it a git repo under ~/projects and commit it.' \
      > "$HOME/AGENTS.md"
    say "wrote $HOME/AGENTS.md, the instructions your agents read (yours to change)"
  fi

  # The desktop window is Electron, installed with the dependencies above; the
  # prebuilt window from older installs is removed.
  rm -f "$BIN_DIR/imperfect-code" "$SHARE"/downloads/imperfect-desktop-*
  sed "s|__ROOT__|$ROOT|g; s|__NODE__|$node_bin|g" "$ROOT/desktop/product/imperfect-open" > "$BIN_DIR/imperfect-open"
  chmod 755 "$BIN_DIR/imperfect-open"

  # Browser “show in folder” uses D-Bus rather than the folder MIME handler.
  install -m 755 "$ROOT/desktop/product/imperfect-file-manager" "$BIN_DIR/imperfect-file-manager"
  mkdir -p "$HOME/.local/share/dbus-1/services"
  cat > "$HOME/.local/share/dbus-1/services/org.freedesktop.FileManager1.service" <<EOF
[D-BUS Service]
Name=org.freedesktop.FileManager1
Exec=$BIN_DIR/imperfect-file-manager
EOF
  # A newly created services directory is not watched until D-Bus reloads.
  if command -v gdbus >/dev/null 2>&1; then
    gdbus call --session --dest org.freedesktop.DBus --object-path /org/freedesktop/DBus --method org.freedesktop.DBus.ReloadConfig >/dev/null 2>&1 || true
  fi

  # Folders open in Files (imperfect on its files panel), and both are in the
  # app launcher. Files once ran as an app of its own; its registration goes.
  rm -f "$PREFIX/apps.json"
  mkdir -p "$APPS"
  for entry in imperfect-code imperfect-files; do
    sed "s|__BIN__|$BIN_DIR|g" "$ROOT/desktop/product/$entry.desktop" > "$APPS/$entry.desktop"
  done
  command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$APPS" 2>/dev/null || true
  if command -v xdg-mime >/dev/null 2>&1; then
    local previous; previous="$(xdg-mime query default inode/directory 2>/dev/null || true)"
    if [[ "$previous" != imperfect-files.desktop ]]; then
      [[ -n "$previous" ]] && printf '%s\n' "$previous" > "$PREFIX/previous-file-manager"
      xdg-mime default imperfect-files.desktop inode/directory
      say "folders now open in Files (was ${previous:-nothing}; ./install.sh undo puts it back)"
    fi
  fi
  # The machine itself: a user service on loopback.
  mkdir -p "$UNIT_DIR"
  cat > "$UNIT_DIR/$UNIT" <<EOF
[Unit]
Description=imperfect (loopback :$PORT)
After=network-online.target

[Service]
Type=simple
WorkingDirectory=$ROOT
Environment=PATH=$(dirname "$node_bin"):$HOME/.local/share/mise/shims:$BIN_DIR:/usr/local/bin:/usr/bin
Environment=IMPERFECT_PREFIX=$PREFIX
Environment=IMPERFECT_PORT=$PORT
ExecStart=$node_bin $ROOT/system/start.mjs
Restart=always
RestartSec=3
# Stopping waits for agent turns to finish instead of cutting them off.
TimeoutStopSec=infinity
KillMode=mixed
# When memory runs out, the kernel kills the hungriest process (an agent's
# ffmpeg, say), not all of imperfect with it.
OOMPolicy=continue

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable "$UNIT" >/dev/null 2>&1 || true
  if systemctl --user is-active --quiet "$UNIT"; then
    if [[ "$(busy)" == 1 ]]; then
      say "an agent is working; the new version starts on the next restart (systemctl --user restart $UNIT)"
    else
      systemctl --user restart "$UNIT"
    fi
  else
    systemctl --user start "$UNIT"
  fi

  # Whether this is the computer the others follow, for memory and the mic.
  local home=0
  IMPERFECT_PREFIX="$PREFIX" "$node_bin" "$ROOT/system/memory.mjs" home || home=$?
  memory_timer "$node_bin" "$home"
  whisper_ears "$node_bin" "$home"

  # Tailscale joins this computer to the buyer's others and to the phone.
  if ! command -v tailscale >/dev/null 2>&1; then
    note "tailscale is not installed: imperfect works on this computer, but other computers and the phone cannot reach it (see AGENTS.md, 'Tailscale')"
  elif ! tailscale status >/dev/null 2>&1; then
    note "tailscale is installed but not logged in (see AGENTS.md, 'Tailscale')"
  # What agents show is served beside imperfect, on its port + 1
  # (system/shown.mjs); published to the person's own devices at :8443, it
  # plays on every screen of theirs. Never funnel.
  elif ! tailscale serve status --json 2>/dev/null | grep -q "\"http://127.0.0.1:$((PORT + 1))\""; then
    if tailscale serve --bg --https=8443 "http://127.0.0.1:$((PORT + 1))" >/dev/null 2>&1; then
      say "what agents show is published to your own devices, at :8443 (undo: tailscale serve --https=8443 off)"
    else
      note "what agents show plays on this computer only: to publish it to your other devices and the phone, run 'sudo tailscale set --operator=\$USER' once, then ./install.sh again"
    fi
  fi

  say "imperfect is running on http://127.0.0.1:$PORT ($(git -C "$ROOT" log -1 --format='%h, %cs' 2>/dev/null || echo 'unversioned'))"
  cat <<EOF

  imperfect-open code    imperfect (the agents); bind it to a key you like
  imperfect-open files   Files (also what opens folders now)
  ./install.sh phone     put the Android app on a phone
  ./install.sh undo      put everything back
  your files:            $PREFIX

EOF
}

setup_phone() {
  need curl; need sha256sum; ensure_node
  local apk; apk="$(fetch_pinned android)"
  [[ -n "$apk" ]] || die "no Android app is pinned in binaries.json yet"
  local dns; dns="$(tailscale status --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).Self.DNSName.replace(/\.$/,""))}catch{}})' || true)"
  [[ -n "$dns" ]] || die "this computer is not on a tailnet yet; the phone reaches it through Tailscale (see AGENTS.md, 'Tailscale')"
  tailscale serve status 2>/dev/null | grep -q "127.0.0.1:$PORT" \
    || note "imperfect is not published on the tailnet yet: run 'tailscale serve --bg $PORT' first"
  # A phone already connected over wireless debugging gets the app and this
  # address straight away; any other phone scans the code.
  if command -v adb >/dev/null 2>&1 && adb devices | awk 'NR>1 && $2=="device"' | grep -q .; then
    adb install -r "$apk"
    adb shell am start -a android.intent.action.VIEW -d "imperfect://$dns" computer.imperfect.code >/dev/null
    say "installed on $(adb devices | awk 'NR>1 && $2=="device"{print $1; exit}'); it is asking to connect to $dns"
    return
  fi
  say "on the phone (on your tailnet, in the Tailscale app), point the camera here:"
  echo
  node "$ROOT/system/qr.mjs" "https://$dns/phone"
  cat <<EOF

  https://$dns/phone
  it opens in the phone's browser: "Get it" installs the app (Android asks to
  allow installs from the browser once), then "Open imperfect" and Connect.
  With the app already on the phone, tap "Scan QR code" in it instead.
  Your other computers come with this one; there is no need to pair each.
EOF
}

teardown() {
  if systemctl --user is-active --quiet "$UNIT" && [[ "$(busy 2>/dev/null)" == 1 ]]; then
    die "an agent is working in imperfect; let it finish, then run this again"
  fi
  systemctl --user disable --now "$UNIT" >/dev/null 2>&1 || true
  systemctl --user disable --now "$MEMORY.timer" "$WHISPER" >/dev/null 2>&1 || true
  rm -f "$UNIT_DIR/$UNIT" "$UNIT_DIR/$MEMORY.timer" "$UNIT_DIR/$MEMORY.service" "$UNIT_DIR/$WHISPER"; systemctl --user daemon-reload || true
  if command -v tailscale >/dev/null 2>&1 && tailscale serve status --json 2>/dev/null | grep -q "\"http://127.0.0.1:$((PORT + 1))\""; then
    tailscale serve --https=8443 off >/dev/null 2>&1 || note "run 'tailscale serve --https=8443 off' to stop publishing what agents show"
  fi
  if command -v xdg-mime >/dev/null 2>&1; then
    xdg-mime default "$(cat "$PREFIX/previous-file-manager" 2>/dev/null || echo org.gnome.Nautilus.desktop)" inode/directory
  fi
  rm -f "$HOME/.local/share/dbus-1/services/org.freedesktop.FileManager1.service" "$BIN_DIR/imperfect-file-manager"
  rm -f "$APPS/imperfect-code.desktop" "$APPS/imperfect-files.desktop"
  rm -f "$BIN_DIR/imperfect-open"
  say "undone. your files in $PREFIX and this checkout are untouched; delete them yourself if you want them gone."
}

# A Mac has its own installer (desktop/mac/install.mjs): imperfect.app in the
# Dock, which keeps the machine running, in place of systemd units and
# .desktop files. Node comes the same way, through mise if need be: the node
# the person's own PATH names first, then where Homebrew, mise and the like
# put theirs, for a shell started without the person's profile.
if [[ "$(uname -s)" == Darwin && "${1:-install}" =~ ^(install|undo)$ ]]; then
  export PATH="$PATH:$HOME/.local/bin:$HOME/.local/share/mise/shims:/opt/homebrew/bin:/usr/local/bin"
  # A new Mac has no node, and nothing to install it with: mise, fetched once
  # for this user (~/.local/bin/mise, checked against its checksum), installs
  # node 22 for this checkout alone.
  if ! node_ok && ! command -v mise >/dev/null 2>&1; then
    say "installing mise (~/.local/bin/mise), to install node 22 with"
    curl -fsSL https://mise.run | MISE_QUIET=1 MISE_INSTALL_HELP=0 sh \
      || die "could not install mise; install node 22 or newer, then run this again"
  fi
  ensure_node
  if [[ "${1:-install}" == undo ]]; then exec "$(node_binary)" "$ROOT/desktop/mac/install.mjs" undo; fi
  exec "$(node_binary)" "$ROOT/desktop/mac/install.mjs"
fi

case "${1:-install}" in
  install) setup ;;
  phone) setup_phone ;;
  undo) teardown ;;
  update) shift; update "$@" ;;
  *) echo "usage: ./install.sh [install|phone|undo|update]" >&2; exit 1 ;;
esac
