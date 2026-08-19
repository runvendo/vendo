---
"@vendoai/vendo": patch
---

A texted turn's opening store calls now go out together. The user's message was
written only after the turn's opening read came back, because on a web turn that
read is what shapes the write — it decides whether the thread is being created,
it supplies the listing title, and it is what `validateUpsert` checks a client's
message against. None of that applies to a text: the message is built in-process
from a delivery Cloud already authenticated, and the thread id comes off the link
row, which only carries one because a turn already ran on that thread. So the
channel path vouches for both facts and the write rides beside the read instead
of behind it, taking one more round trip off the front of every reply. Web and
API turns are untouched, and the marker that carries the vouch is a symbol that
is not exported and cannot arrive on a JSON body.
