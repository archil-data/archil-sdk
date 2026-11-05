---
"disk": patch
"@archildata/python": patch
---

Sandbox process connections send their connection token in the WebSocket `Sec-WebSocket-Protocol` header instead of the URL, when the API provides one, so the token no longer appears in logs that record request URLs.
