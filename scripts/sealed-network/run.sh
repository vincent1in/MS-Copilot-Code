#!/bin/sh
# What does the gateway send, and to whom? Four independent records of one run, on Linux:
#   1. the gateway's own allowlist, which refuses and logs anything else;
#   2. a Node-level recorder on every connection attempt (scripts/net-guard.cjs, in
#      log-only mode here, so nothing is hidden from the next two);
#   3. strace on every network system call of every process in the tree;
#   4. the cable: the gateway runs in its own network namespace whose only way out is a
#      virtual cable to a "sink" namespace. The sink answers every DNS question with its
#      own address and logs every lookup, connection and TLS server name it sees, and
#      tcpdump records every packet. Nothing reaches the internet.
# And inbound: from the sink, it tries to connect to every port the gateway listens on.
#
# Scenarios: not signed in (help, doctor, setup, the page, a setting, Connect, a test
# message); the plugin inside OpenCode; signed in with a valid token and with an expired
# one (a real MSAL cache, made offline with fake tokens); and the sign-in window.
#
# Needs root (network namespaces), iproute2, tcpdump, strace, python3 and node; for the
# sign-in window also xvfb-run and Chrome (CHROMIUM_PATH, default /usr/bin/google-chrome).
# Usage: sudo sh scripts/sealed-network/run.sh [output-dir]
set -u
SINK=""; DUMP=""
HERE=$(cd "$(dirname "$0")" && pwd)
GW=$(cd "$HERE/../.." && pwd)
OUT=${1:-$GW/sealed-network-result}
rm -rf "$OUT"; mkdir -p "$OUT"
cleanup() { [ -n "$SINK" ] && kill $SINK 2>/dev/null; [ -n "$DUMP" ] && kill $DUMP 2>/dev/null; ip netns del gwns 2>/dev/null; ip netns del sinkns 2>/dev/null; rm -rf /etc/netns/gwns; }
trap cleanup EXIT
cleanup

ip netns add gwns; ip netns add sinkns
ip link add vgw type veth peer name vsink
ip link set vgw netns gwns; ip link set vsink netns sinkns
ip -n gwns addr add 10.77.0.2/24 dev vgw; ip -n gwns link set vgw up; ip -n gwns link set lo up
ip -n sinkns addr add 10.77.0.1/24 dev vsink; ip -n sinkns link set vsink up; ip -n sinkns link set lo up
ip -n gwns route add default via 10.77.0.1
mkdir -p /etc/netns/gwns && echo "nameserver 10.77.0.1" > /etc/netns/gwns/resolv.conf

ip netns exec sinkns tcpdump -i vsink -n -U -w "$OUT/wire.pcap" 2>/dev/null & DUMP=$!
ip netns exec sinkns python3 "$HERE/sink.py" 10.77.0.1 "$OUT/sink.jsonl" & SINK=$!
sleep 2

node "$HERE/make-cache.mjs" "$OUT" valid >/dev/null && mv "$OUT/msal-cache.json" "$OUT/cache-valid.json"
node "$HERE/make-cache.mjs" "$OUT" expired >/dev/null && mv "$OUT/msal-cache.json" "$OUT/cache-expired.json"

inside() {  # run a scenario in the gateway's namespace with no proxy settings, under strace
  name=$1; shift
  ip netns exec gwns env -u HTTPS_PROXY -u HTTP_PROXY -u https_proxy -u http_proxy -u ALL_PROXY -u all_proxy -u NO_PROXY -u no_proxy \
    strace -f -qq -e trace=connect,sendto,sendmsg,sendmmsg,bind -o "$OUT/strace-$name.txt" \
    "$@"
}
probe_inbound() {  # from the sink: can anything reach the gateway's ports from outside the machine?
  sleep 4
  for port in 4141 $(ip netns exec gwns ss -ltnH | awk '{print $4}' | sed 's/.*://' | sort -u); do
    if ip netns exec sinkns timeout 2 bash -c "</dev/tcp/10.77.0.2/$port" 2>/dev/null; then echo "port $port: REACHABLE from outside"; else echo "port $port: refused from outside"; fi
  done > "$OUT/inbound-$1.txt"
  ip netns exec gwns ss -ltnH > "$OUT/listening-$1.txt"
}

probe_inbound A & PROBE=$!; inside notSignedIn node "$HERE/scenarios.mjs" "$GW" "$OUT" notSignedIn; wait $PROBE
probe_inbound B & PROBE=$!; inside insideOpenCode node "$HERE/scenarios.mjs" "$GW" "$OUT" insideOpenCode; wait $PROBE
inside valid node "$HERE/scenarios.mjs" "$GW" "$OUT" valid
inside expired node "$HERE/scenarios.mjs" "$GW" "$OUT" expired
# Chrome's crash handler and strace both want ptrace, so the sign-in window runs without
# strace: the cable and the Node recorder still see everything it does.
if command -v xvfb-run >/dev/null 2>&1 && [ -x "${CHROMIUM_PATH:-/usr/bin/google-chrome}" ]; then
  ip netns exec gwns env -u HTTPS_PROXY -u HTTP_PROXY -u https_proxy -u http_proxy -u ALL_PROXY -u all_proxy -u NO_PROXY -u no_proxy \
    xvfb-run -a node "$HERE/scenarios.mjs" "$GW" "$OUT" signInWindow > "$OUT/scenario-E.log" 2>&1
else
  echo "Skipped the sign-in window: it needs xvfb-run and Chrome." > "$OUT/scenario-E.log"
fi
sleep 3
kill $DUMP; DUMP=""; sleep 1
python3 "$HERE/analyze.py" "$OUT" | tee "$OUT/summary.txt"
