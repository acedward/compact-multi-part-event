#!/usr/bin/env python3
"""Derive the v1 golden vectors from the normative wire table alone.

This script deliberately shares no code with the TypeScript writer or reader.
It uses only Python's standard library (hashlib, struct, json).

Wire table (v1):
  event name  = b"mip-xxxx[v1]:" + b"ppp:nnn" + 12 zero bytes               (32 bytes)
              (the circuit copies tail[0:8] after the 13-byte prefix, then 11 zeros)
  payload     = request_id (32 bytes) + tail (224 bytes)                   (256 bytes)
  tail[0:7]   = ASCII "ppp:nnn": 1-based part and total, three zero-padded digits each
  tail[7]     = 0
  tail[8:16]  = message length L, uint64 little-endian
  tail[16:224]= message bytes [(p-1)*208, p*208), zero padded after byte L
  n           = max(1, ceil(L / 208))
  request_id  = SHA-256(tail_1 || ... || tail_n)

Usage: python3 vectors/derive.py > vectors/v1.json
"""

import hashlib
import json
import struct

PREFIX = b"mip-xxxx[v1]:"
DATA = 208


def pattern(length, seed=0):
    return bytes(((i * 37 + 11 + seed) & 0xFF) for i in range(length))


def tails_for(message):
    n = max(1, -(-len(message) // DATA))
    tails = []
    for p in range(1, n + 1):
        text = ("%03d:%03d" % (p, n)).encode("ascii")
        assert len(text) == 7
        chunk = message[(p - 1) * DATA : p * DATA]
        tail = text.ljust(8, b"\0") + struct.pack("<Q", len(message)) + chunk.ljust(DATA, b"\0")
        assert len(tail) == 224
        tails.append(tail)
    return tails


def name_for(tail):
    name = PREFIX + tail[:8] + b"\0" * 11
    assert len(name) == 32
    return name


def canonical_name(p, n):
    return ("mip-xxxx[v1]:%03d:%03d" % (p, n)).encode("ascii").ljust(32, b"\0")


def request_id(tails):
    return hashlib.sha256(b"".join(tails)).digest()


def publication(vector_id, message, note):
    tails = tails_for(message)
    rid = request_id(tails)
    for p, tail in enumerate(tails, start=1):
        # The name the circuit derives equals pad("mip-xxxx[v1]:ppp:nnn", 32).
        assert name_for(tail) == canonical_name(p, len(tails))
    return {
        "id": vector_id,
        "note": note,
        "messageLength": len(message),
        "messageHex": message.hex(),
        "requestId": rid.hex(),
        "parts": [
            {
                "position": p,
                "total": len(tails),
                "tail": tail.hex(),
                "name": name_for(tail).hex(),
            }
            for p, tail in enumerate(tails, start=1)
        ],
    }


def event(name, payload, event_id="e1"):
    return {"eventId": event_id, "name": name.hex(), "payload": payload.hex()}


def valid_vectors():
    vectors = []
    for length in (0, 1, 207, 208, 209, 416, 417, 640, 1024):
        vectors.append(
            publication("len-%d" % length, pattern(length), "pattern (i*37+11) mod 256")
        )
    vectors.append(
        publication(
            "parts-46",
            pattern(46 * DATA),
            "46 full parts (format vector; the prototype's block fit without access control)",
        )
    )
    zeros = bytearray(pattern(300, 5))
    for i in (0, 1, 150, 207, 208, 209):
        zeros[i] = 0
    zeros[-12:] = b"\0" * 12
    vectors.append(
        publication(
            "zeros-300",
            bytes(zeros),
            "pattern seed 5 with embedded zeros (0,1,150,207,208,209) and 12 meaningful trailing zeros",
        )
    )
    vectors.append(publication("all-zero-416", bytes(416), "416 zero bytes: every byte is meaningful"))
    return vectors


def single_event_cases():
    """Single events derived from the valid 417-byte publication (3 parts)."""
    message = pattern(417)
    tails = tails_for(message)
    rid = request_id(tails)
    t1 = tails[0]
    t3 = tails[2]
    cases = []

    def add(case_id, description, name, payload, expect, reason):
        cases.append(
            {
                "id": case_id,
                "description": description,
                "event": event(name, payload),
                "expect": expect,
                "reason": reason,
            }
        )

    def with_position(tail, text):
        return text.ljust(8, b"\0")[:8] + tail[8:]

    def reencode(tail):
        return name_for(tail), rid + tail

    for case_id, text, reason in (
        ("position-zero", b"000:003", "part number is 000"),
        ("position-total-zero", b"001:000", "part total is 000"),
        ("position-exceeds-total", b"004:003", "part number exceeds the total"),
        ("position-unpadded", b"1:3", "part number is not three ASCII digits"),
        ("position-short-total", b"001:3", "part total is not three ASCII digits"),
        ("position-two-digit-part", b"01:003", "part number is not three ASCII digits"),
        ("position-non-digit", b"0a1:003", "part number is not three ASCII digits"),
        ("position-space", b" 01:003", "part number is not three ASCII digits"),
        ("position-no-colon", b"001-003", "byte 3 is not a colon"),
        ("position-byte7", b"001:003x", "byte 7 is not zero"),
        ("position-four-digit-part", b"0001:003", "byte 3 is not a colon"),
        ("position-empty", b"", "part number is not three ASCII digits"),
        ("position-total-mismatch", b"001:002", "not canonical for message length 417"),
    ):
        tail = with_position(t1, text)
        name, payload = reencode(tail)
        add(case_id, "tail bytes 0..7 = %r" % text, name, payload, "rejected", reason)

    add("name-unpadded-position", "name says 1:3 (unpadded), tail says 001:003",
        PREFIX + b"1:3" + b"\0" * 16, rid + t1, "rejected", "differ from tail bytes 0..6")

    tail = t1[:8] + struct.pack("<Q", 1 << 63) + t1[16:]
    name, payload = reencode(tail)
    add("length-huge", "declared length 2^63", name, payload, "rejected", "exceeds maxMessageBytes")

    padded = bytearray(t3)
    padded[223] = 1
    name, payload = reencode(bytes(padded))
    add("padding-last-byte", "final part: non-zero byte 223", name, payload, "rejected",
        "non-zero bytes after the message data")

    padded = bytearray(t3)
    padded[16 + (417 - 2 * DATA)] = 1
    name, payload = reencode(bytes(padded))
    add("padding-first-byte", "final part: first padding byte non-zero", name, payload, "rejected",
        "non-zero bytes after the message data")

    add("name-suffix-differs", "name says 002:003, tail says 001:003",
        PREFIX + b"002:003" + b"\0" * 12, rid + t1, "rejected", "differ from tail bytes 0..6")

    bad_name = bytearray(name_for(t1))
    bad_name[31] = 1
    add("name-zero-bytes", "name byte 31 non-zero", bytes(bad_name), rid + t1, "rejected",
        "bytes 20..31 are not zero")

    bad_name = bytearray(name_for(t1))
    bad_name[20] = 0x78
    add("name-byte-20", "name byte 20 (the copied tail byte 7) non-zero while the tail's is zero",
        bytes(bad_name), rid + t1, "rejected", "bytes 20..31 are not zero")

    add("name-31-bytes", "name one byte short", name_for(t1)[:31], rid + t1, "rejected",
        "event name must be 32 bytes")
    add("name-33-bytes", "name one byte long", name_for(t1) + b"\0", rid + t1, "rejected",
        "event name must be 32 bytes")
    add("payload-255-bytes", "payload one byte short (trimmed, not restored)", name_for(t1),
        (rid + t1)[:255], "rejected", "event payload must be 256 bytes")
    add("payload-257-bytes", "payload one byte long", name_for(t1), rid + t1 + b"\0", "rejected",
        "event payload must be 256 bytes")
    add("payload-31-bytes", "payload too short to name a request ID", name_for(t1), rid[:31],
        "ungroupable", "event payload must be 256 bytes")

    add("foreign-other-version", "another profile version", b"mip-xxxx[v2]:001:003".ljust(32, b"\0"),
        rid + t1, "ignored", "")
    add("foreign-other-name", "an unrelated event name", b"app:transfer".ljust(32, b"\0"),
        rid + t1, "ignored", "")
    add("foreign-short-name", "a name shorter than the prefix", b"mip-xxxx", rid + t1, "ignored", "")
    return cases


def group_cases():
    """Whole-group cases on the 417-byte publication."""
    message = pattern(417)
    tails = tails_for(message)
    rid = request_id(tails)

    def ev(tail, event_id, request=rid):
        return event(name_for(tail), request + tail, event_id)

    complete = [ev(t, "e%d" % i) for i, t in enumerate(tails, start=1)]
    changed = bytearray(tails[1])
    changed[100] ^= 0xFF
    other_length = tails_for(pattern(418))
    cases = [
        {"id": "complete", "events": complete, "expect": "complete", "reason": ""},
        {"id": "reversed", "events": list(reversed(complete)), "expect": "complete", "reason": ""},
        {"id": "redelivery", "events": complete + [complete[0]], "expect": "complete", "reason": ""},
        {"id": "missing-part", "events": complete[:2], "expect": "incomplete",
         "reason": "missing parts: 3"},
        {"id": "emitted-twice", "events": complete + [ev(tails[0], "e4")], "expect": "rejected",
         "reason": "part 1 was emitted 2 times"},
        {"id": "conflicting-part", "events": complete + [ev(bytes(changed), "e4")],
         "expect": "rejected", "reason": "conflicting data for part 2"},
        {"id": "hash-mismatch", "events": [ev(t, "e%d" % i, bytes(32)) for i, t in enumerate(tails, 1)],
         "expect": "rejected", "reason": "does not match the request ID"},
        {"id": "metadata-disagreement",
         "events": [ev(tails[0], "e1"), ev(tails[1], "e2"), ev(other_length[2], "e3")],
         "expect": "rejected", "reason": "disagree on the part total or message length"},
    ]
    return cases


def main():
    doc = {
        "profile": "mip-xxxx[v1]",
        "derivation": "vectors/derive.py: Python standard library only, from the normative wire table; "
        "shares no code with the TypeScript writer or reader",
        "encoding": "lowercase hex; payload = requestId || tail",
        "valid": valid_vectors(),
        "invalidEvents": single_event_cases(),
        "groups": group_cases(),
    }
    print(json.dumps(doc, indent=1))


if __name__ == "__main__":
    main()
