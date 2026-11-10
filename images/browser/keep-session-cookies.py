#!/usr/bin/env python3
"""Login mode, before the container stops: give the session cookies (no expiry) of the given hosts a 30 day expiry, then quit Chrome.

Chrome drops cookies without an expiry when it quits, so a manual login would be lost on `jobwatch login stop`. This is the same copy
the router makes at the end of each call (`persistentCopies` in packages/core/src/browser/session.ts). Cookie values are never printed.
Usage: keep-session-cookies.py <host>...   Prints the number of cookies extended.
"""
import asyncio
import json
import sys
import time
import urllib.request

import websockets

TTL_S = 30 * 24 * 3600
DEVTOOLS = "http://127.0.0.1:9223"
PARAM_KEYS = ("name", "value", "domain", "path", "httpOnly", "secure", "sameSite")


def belongs(cookie, hosts):
    domain = cookie["domain"].lstrip(".").lower()
    return any(host == domain or host.endswith("." + domain) for host in hosts)


async def main(hosts):
    version = json.load(urllib.request.urlopen(DEVTOOLS + "/json/version", timeout=10))
    async with websockets.connect(version["webSocketDebuggerUrl"], max_size=None) as ws:
        next_id = 0

        async def send(method, params=None):
            nonlocal next_id
            next_id += 1
            await ws.send(json.dumps({"id": next_id, "method": method, "params": params or {}}))
            while True:
                reply = json.loads(await ws.recv())
                if reply.get("id") == next_id:
                    if "error" in reply:
                        raise RuntimeError(method + ": " + reply["error"].get("message", "failed"))
                    return reply.get("result", {})

        expires = int(time.time()) + TTL_S
        cookies = (await send("Storage.getCookies"))["cookies"]
        copies = [
            {**{key: cookie[key] for key in PARAM_KEYS if key in cookie}, "expires": expires}
            for cookie in cookies
            if cookie.get("session") and belongs(cookie, hosts)
        ]
        if copies:
            await send("Storage.setCookies", {"cookies": copies})
        print(len(copies), flush=True)  # before Chrome quits: the container stops with it and takes this process along
        # A graceful quit flushes the cookie database to the profile; Chrome exits before it can answer.
        try:
            await send("Browser.close")
        except websockets.ConnectionClosed:
            pass


asyncio.run(main([host.lower() for host in sys.argv[1:]]))
