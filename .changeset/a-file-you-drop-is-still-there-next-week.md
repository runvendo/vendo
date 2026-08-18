---
"@vendoai/core": minor
"@vendoai/ui": minor
"@vendoai/vendo": minor
---

A file your user drops in chat is now theirs to keep. It is saved into their own
`/user/files/`, private to them, and it is still there in next week's
conversation — where the agent can list it, read it, and build on it. Until now
an attachment rode one message and ended with it.

The message that follows a drop carries only a reference to the file, which is
what keeps a transcript light: a spreadsheet is stored once instead of being
repeated in full on every turn of the conversation about it. Images are the
deliberate exception and still ride inline, because that is how a model sees a
picture at all. On the way to the model a saved file becomes a line of text
naming it and where it landed — a provider handed a workspace path where it
expects file data would read the path as base64 and think about garbage.

Two read-only tools come with every deployment, no adapter and no key:
`vendo_user_files_list` and `vendo_user_files_read`. They are on the one
registry, so they are guarded, audited and searchable exactly like a host tool,
with no privileged side door. Neither takes a path — only a file NAME, from
which the path is built server-side — so there is no caller-supplied path for a
`..` to climb out of the drawer with, and the name check that refuses separators
and dot-segments is the same one the write doors use. A long file is read 200
lines at a time so a spreadsheet is walked rather than cut off mid-row, and a
file that is not text answers with its type and size instead of mojibake.

Building an app from a file COPIES what it needs — the rows of a table become
the app's own saved items. That copy is a snapshot, not a live link, and there
is no watcher and no background sync anywhere in this design: when a newer
version of the file arrives the AGENT is what notices, says the file was
replaced, and updates what it built. Uploading the same name replaces the file,
because re-sending a corrected export is the common case and a drawer that
quietly accumulated four near-identical spreadsheets would serve nobody. In this
release a PDF or an image lands in the drawer and can be described, but does not
reach an app.

`POST /files` is the door — the file's raw bytes under its own media type, no
multipart, capped at 5 MiB — and `vendo.putUserFile({ principal, name, content })`
is the same server-side write called from host code, for pushing a file at a
user without waiting for them to bring one. It delivers nothing and starts no
turn; the file is simply there next time they chat, and the door's cap does not
bind it. In the browser it is one call: `client.files.upload(file)`.

Because an upload's body is bytes rather than JSON, that door sits outside the
wire's json-mutation CSRF floor, and the tolls the other exempt doors pay do not
transfer: an upload's Content-Type is the file's own, and real files are
`text/plain`, which is CORS-safelisted. So it requires a custom request header
instead (`UPLOAD_HEADER`, sent by the client). A browser cannot set one on a
cross-origin request without winning a preflight this wire never answers, which
is what keeps a hostile page from pushing files into a signed-in user's drawer
on their ambient session cookie.

Storage is the ordinary BYO seam. Unset, files live in your store's own blobs;
`createVendo({ files })` takes any S3-compatible bucket to raise that, `vendo
doctor` reports where a deployment's uploads land, and the boot block adds a
`files` row when you have wired an adapter of your own.
