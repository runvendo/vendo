---
"@vendoai/store": patch
---

`VENDO_STORE_TRACE`'s line stops lying about how slow the store is. It printed
one number, `ms=`, and folded three things that are not the door's latency into
it: the retry's own backoff (250ms to 10s, whatever `Retry-After` asked for),
event-loop queueing on a busy container, and the instrument's OWN second full
read of the response body — a `clone().arrayBuffer()` awaited inside the timed
span, which also charged every traced call for being measured. A 40ms door with
one retry behind it reported `ms=1347`; in the field a healthy 54ms read as 2.1s
and sent an afternoon after a store that was never slow.

The line now separates the clocks and says how many attempts it took:

```
vendo-store-trace op=engine.get path=/engine/get net=44 total=1046 retried=1 bytes=? outcome=ok
```

`net=` is time on the wire — request start to response headers, summed over
attempts — so it is the number to compare against the server's own. `total=` is
what the caller waited, backoff included, and the gap between the two IS the
wait rather than a mystery. `retried=` names the replay that opened the gap.

`bytes=` is now the size the server declared in `content-length`, and `?` where
it declared none: nothing is read to find out, so the body reaches the caller
whole and unread and a slow transfer is no longer billed to the door twice.
Losing the size on a chunked answer is the price of that, and the cheaper fix
lives on the server — the console could stamp its own processing time on the
response and make `net` decomposable — so the trade is temporary.
