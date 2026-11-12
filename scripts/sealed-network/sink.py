#!/usr/bin/env python3
"""The far end of the sealed test network. Every DNS question gets this machine's own
address back, so a program that looks something up then connects here. Every connection
is logged with the TLS server name (SNI) or the first line it sent, then closed. Nothing
is forwarded anywhere."""
import json, socket, struct, sys, threading, time

ADDR = sys.argv[1]
LOG = open(sys.argv[2], "a", buffering=1)
PORTS = [80, 443, 853, 5228, 8080, 8443]

def log(**entry):
    entry["t"] = time.time()
    LOG.write(json.dumps(entry) + "\n")

def qname(data, offset=12):
    labels = []
    while data[offset]:
        n = data[offset]; labels.append(data[offset + 1: offset + 1 + n].decode("ascii", "replace")); offset += n + 1
    return ".".join(labels), offset + 1

def dns():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.bind((ADDR, 53))
    while True:
        data, peer = s.recvfrom(4096)
        try:
            name, end = qname(data); qtype = struct.unpack(">H", data[end:end + 2])[0]
        except Exception:
            log(kind="dns", name="(unparsable)", peer=peer[0]); continue
        log(kind="dns", name=name, qtype=qtype, peer=peer[0])
        header = data[:2] + b"\x81\x80" + data[4:6] + (b"\x00\x01" if qtype == 1 else b"\x00\x00") + b"\x00\x00\x00\x00"
        answer = (b"\xc0\x0c\x00\x01\x00\x01\x00\x00\x00\x3c\x00\x04" + socket.inet_aton(ADDR)) if qtype == 1 else b""
        s.sendto(header + data[12:end + 4] + answer, peer)

def sni(hello):
    try:
        if hello[0] != 0x16: return None
        p = 5 + 4 + 2 + 32; p += 1 + hello[p]
        p += 2 + struct.unpack(">H", hello[p:p + 2])[0]; p += 1 + hello[p]
        end = p + 2 + struct.unpack(">H", hello[p:p + 2])[0]; p += 2
        while p + 4 <= end:
            kind, size = struct.unpack(">HH", hello[p:p + 4]); p += 4
            if kind == 0: return hello[p + 5: p + 5 + struct.unpack(">H", hello[p + 3:p + 5])[0]].decode("ascii", "replace")
            p += size
    except Exception:
        return "(unparsable ClientHello)"
    return None

def tcp(port):
    s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1); s.bind((ADDR, port)); s.listen(64)
    while True:
        conn, peer = s.accept(); conn.settimeout(3)
        try: first = conn.recv(4096)
        except Exception: first = b""
        name = sni(first)
        log(kind="tcp", port=port, peer=peer[0], sni=name, first=None if name else first[:120].decode("latin-1"))
        conn.close()

for target in [dns] + [lambda p=p: tcp(p) for p in PORTS]:
    threading.Thread(target=target, daemon=True).start()
log(kind="ready")
while True: time.sleep(3600)
