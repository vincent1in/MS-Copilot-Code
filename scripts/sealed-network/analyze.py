#!/usr/bin/env python3
"""Split every recorder's output by scenario, print what left the sealed network, and
end with a verdict: every name looked up or connected to must be one of the two Microsoft
hosts the gateway is allowed, and every port it listens on must refuse the outside."""
import json, re, subprocess, sys
from collections import Counter, defaultdict
out = sys.argv[1]
steps, open_ = [], {}
for line in open(f"{out}/steps.jsonl"):
    e = json.loads(line)
    if e["phase"] == "start": open_[e["step"]] = e["t"]
    else: steps.append((e["step"], open_.pop(e["step"]), e["t"]))
# A step that never wrote its end (a browser that had to be stopped) runs to the last record.
last = max([json.loads(l)["t"] for l in open(f"{out}/sink.jsonl")] + [t for _, _, t in steps] + list(open_.values()))
for name, t in open_.items(): steps.append((name, t, last))
steps.sort(key=lambda s: s[1])
def step_of(t):
    # The latest step that had started by then, if it ended no more than 2 s before.
    started = [(a, name, b) for name, a, b in steps if a - 0.5 <= t]
    if not started: return "(between steps)"
    a, name, b = max(started)
    return name if t <= b + 2.0 else "(between steps)"

wire = defaultdict(Counter)
for line in open(f"{out}/sink.jsonl"):
    e = json.loads(line)
    if e["kind"] == "dns": wire[step_of(e["t"])][f"DNS lookup  {e['name']}"] += 1
    elif e["kind"] == "tcp": wire[step_of(e["t"])][f"TCP :{e['port']}  " + (f"TLS server name {e['sni']}" if e.get("sni") else f"first bytes {e.get('first')!r}")] += 1

# Every packet on the cable, by flow, as a cross-check on the sink's own log.
flows = Counter()
pcap = subprocess.run(["tcpdump", "-n", "-r", f"{out}/wire.pcap", "-tt"], capture_output=True, text=True).stdout
for line in pcap.splitlines():
    m = re.match(r"([\d.]+) IP (\S+) > (\S+): (.*)", line)
    if not m: 
        if line.strip(): flows[("non-IP", line.split(" ", 2)[1] if len(line.split()) > 1 else line)] += 1
        continue
    src, dst = m.group(2), m.group(3).rstrip(":")
    if src.startswith("10.77.0.2"):
        rest = m.group(4)
        if "Flags [R" in rest and int(src.rsplit(".", 1)[1]) not in (53,) and int(dst.rsplit(".", 1)[1]) > 1024:
            flows[(step_of(float(m.group(1))), f"refusal of the inbound probe to port {src.rsplit('.', 1)[1]}")] += 1
            continue
        proto = "UDP" if "UDP" in rest or re.search(r"\b(A\?|AAAA\?|HTTPS\?)", rest) else "TCP"
        flows[(step_of(float(m.group(1))), f"{proto} to {dst.rsplit('.', 1)[0]} port {dst.rsplit('.', 1)[1]}")] += 1

names = {"notSignedIn": "A", "insideOpenCode": "B", "valid": "C", "expired": "D", "signInWindow": "E"}
guard = defaultdict(Counter)
guarded = Counter()
for key, letter in names.items():
    try: lines = open(f"{out}/net-guard-{key}.jsonl").read().splitlines()
    except FileNotFoundError: continue
    for line in lines:
        e = json.loads(line)
        if e.get("kind") == "loaded": guarded[letter] += 1; continue
        if e.get("local"): continue
        guard[letter][f"{e['kind']} {e.get('host')}:{e.get('port')} {e.get('url','')}".strip()] += 1
sys_out = defaultdict(Counter)
for key, letter in names.items():
    try: text = open(f"{out}/strace-{key}.txt").read()
    except FileNotFoundError: continue
    for line in text.splitlines():
        m = re.search(r"(connect|sendto|sendmsg|sendmmsg|bind)\(\d+, .*?sin_port=htons\((\d+)\), sin_addr=inet_addr\(\"([\d.]+)\"\)", line)
        if m:
            call, port, addr = m.groups()
            if addr.startswith("127.") or addr == "0.0.0.0": continue
            sys_out[letter][f"{call} to {addr}:{port}"] += 1
        m6 = re.search(r"(connect|sendto)\(\d+, \{sa_family=AF_INET6, sin6_port=htons\((\d+)\).*inet_pton\(AF_INET6, \"([^\"]+)\"", line)
        if m6 and m6.group(3) not in ("::1", "::"):
            sys_out[letter][f"{m6.group(1)} to [{m6.group(3)}]:{m6.group(2)}"] += 1

for name, a, b in steps:
    letter = name.split()[0][0]
    print(f"\n=== {name}  ({b - a:.0f} s)")
    print("  on the wire (sink):     ", "; ".join(f"{k} ×{v}" for k, v in wire[name].items()) or "nothing")
    pk = {k[1]: v for k, v in flows.items() if k[0] == name}
    print("  on the wire (tcpdump):  ", "; ".join(f"{k} ×{v}" for k, v in pk.items()) or "no packets")
    traced = __import__("os").path.exists(f"{out}/strace-{[k for k, v in names.items() if v == letter][0]}.txt")
    print("  system calls (strace):  ", ("; ".join(f"{k} ×{v}" for k, v in sys_out[letter].items()) or "none off this machine") if traced else "not traced (the browser and strace both need ptrace)")
    print(f"  Node recorder ({guarded[letter]} processes):", "; ".join(f"{k} ×{v}" for k, v in guard[letter].items()) or "none off this machine")
other = {k: v for k, v in flows.items() if k[0] in ("(between steps)", "non-IP")}
print("\nOutside any step:", other or "nothing")

ALLOWED = {"login.microsoftonline.com", "substrate.office.com"}
names_seen = Counter()
for line in open(f"{out}/sink.jsonl"):
    e = json.loads(line)
    if e["kind"] == "dns": names_seen[e["name"]] += 1
    elif e["kind"] == "tcp": names_seen[e.get("sni") or f"(no TLS name: {e.get('first')!r})"] += 1
outside = {n: c for n, c in names_seen.items() if n not in ALLOWED}
inbound = []
for path in sorted(__import__("glob").glob(f"{out}/inbound-*.txt")):
    inbound += [l.strip() for l in open(path) if l.strip()]
print("\nVERDICT")
print("  names looked up or connected to:", dict(names_seen) or "none")
print("  outside the two allowed Microsoft hosts:", outside or "none")
print("  inbound from outside the machine:", "all refused" if inbound and all("refused" in l for l in inbound) else inbound)
